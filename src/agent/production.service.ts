import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import * as Joi from 'joi';
import { AgentStore } from './agent.store';
import { AgentAssetsService, safeFilename } from './agent-assets.service';
import { AgentService, publicAsset } from './agent.service';
import { idSchema, parse, templateSchema } from './agent.schemas';
import { ApiError } from '../common/api-error';
import type {
  Asset,
  Entity,
  MockupTemplate,
  Run,
  AgentUser,
} from './agent.types';
import { parseCsv, skuValid, type ExportPreset } from './production.util';
import { renderTemplate } from './template-renderer';
import { WorkspaceService } from './workspace.service';

export interface Batch extends Entity {
  name: string;
  conversationId: string;
  provider: string;
  imageModel?: string;
  projectId?: string;
  rows: {
    sku: string;
    sourceId: string;
    targetId: string;
    prompt: string;
    runId: string;
  }[];
}
@Injectable()
export class ProductionService {
  private rendering = 0;
  constructor(
    private readonly store: AgentStore,
    private readonly assets: AgentAssetsService,
    private readonly agent: AgentService,
    private readonly workspace: WorkspaceService,
  ) {}
  saveExport(
    owner: string,
    buffer: Buffer,
    fields: Pick<Asset, 'name' | 'kind' | 'category'> & { parentId: string },
  ) {
    return this.assets.save(owner, buffer, fields, true);
  }
  async preview(
    owner: string,
    csv: string,
    mapping: Record<'sku' | 'sourceId' | 'targetId' | 'prompt', string>,
  ) {
    const [headers, ...values] = parseCsv(csv);
    const columns = Object.fromEntries(
      Object.entries(mapping).map(([key, value]) => [
        key,
        headers.indexOf(value),
      ]),
    );
    if (Object.values(columns).some((index) => index < 0))
      throw new ApiError(
        400,
        'BATCH_COLUMN_INVALID',
        'Hãy ánh xạ đầy đủ các cột SKU, nguồn, tham chiếu và prompt.',
      );
    const seen = new Set<string>();
    const rows = values.map((value, index) => {
      const sku = value[columns.sku],
        sourceId = parse<string>(idSchema.required(), value[columns.sourceId]),
        targetId = parse<string>(idSchema.required(), value[columns.targetId]);
      if (!skuValid(sku) || seen.has(sku))
        throw new ApiError(
          400,
          'BATCH_SKU_INVALID',
          `Dòng ${index + 2}: SKU chỉ dùng chữ, số, _ và -, không trùng nhau.`,
        );
      seen.add(sku);
      if (sourceId === targetId)
        throw new ApiError(
          400,
          'AGENT_IMAGE_ROLE',
          `Dòng ${index + 2}: nguồn và tham chiếu phải khác nhau.`,
        );
      const prompt = parse<string>(
        Joi.string().min(3).max(8000).required(),
        value[columns.prompt],
      );
      return { sku, sourceId, targetId, prompt };
    });
    if (!rows.length)
      throw new ApiError(400, 'BATCH_EMPTY', 'CSV chưa có dòng dữ liệu.');
    const ids = [...new Set(rows.flatMap((r) => [r.sourceId, r.targetId]))];
    const assets = await this.store.query<Asset>(
      'asset',
      { owner, id: { $in: ids } },
      1000,
    );
    if (assets.length !== ids.length)
      throw new ApiError(
        404,
        'BATCH_ASSET_UNAVAILABLE',
        'CSV chứa ảnh không tồn tại hoặc không thuộc tài khoản của bạn.',
      );
    return rows;
  }
  async createBatch(
    user: AgentUser,
    input: {
      name: string;
      csv: string;
      mapping: Record<'sku' | 'sourceId' | 'targetId' | 'prompt', string>;
      provider: string;
      imageModel?: string;
      projectId?: string;
    },
  ) {
    if (input.projectId)
      await this.workspace.project(user, input.projectId, [
        'editor',
        'manager',
      ]);
    const rows = await this.preview(user.id, input.csv, input.mapping);
    const conversation = await this.agent.createConversation(
      user.id,
      `Batch: ${input.name}`,
    );
    // One immutable run ID per group; resume reuses it, so interrupted submissions cannot duplicate paid work.
    let runId = randomUUID(),
      count = 0,
      size = 0;
    const planned = rows.map((row) => {
      const bytes = JSON.stringify(row).length;
      if (count >= 20 || size + bytes > 10000) {
        runId = randomUUID();
        count = 0;
        size = 0;
      }
      count++;
      size += bytes;
      return { ...row, runId };
    });
    return this.store.insert(
      'batch',
      this.store.create<Batch>(user.id, {
        name: input.name,
        conversationId: conversation.id,
        provider: input.provider,
        ...(input.imageModel ? { imageModel: input.imageModel } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        rows: planned,
      }),
    );
  }
  async batch(owner: string, id: string) {
    const batch = await this.store.get<Batch>('batch', id, owner);
    const runs = await this.store.query<Run>(
      'run',
      { owner, id: { $in: [...new Set(batch.rows.map((r) => r.runId))] } },
      500,
    );
    return {
      batch,
      runs: runs.map((r) => ({
        id: r.id,
        state: r.state,
        conversationId: r.conversationId,
        count: r.count,
      })),
    };
  }
  async submit(owner: string, id: string, requestId: string) {
    const { batch, runs } = await this.batch(owner, id);
    const next = batch.rows.find(
      (row) => !runs.some((run) => run.id === row.runId),
    );
    if (!next) return { done: true, ...(await this.batch(owner, id)) };
    const rows = batch.rows.filter((row) => row.runId === next.runId);
    const run = await this.agent.message(
      owner,
      batch.conversationId,
      {
        id: next.runId,
        text:
          `Xử lý batch ${batch.name}. Mỗi task là cặp nguồn/ảnh đích riêng, không ghép chéo. Giữ SKU và dùng yêu cầu riêng từng dòng.\n` +
          JSON.stringify(rows.map(({ sku, prompt }) => ({ sku, prompt }))),
        operation: 'mockup_ai',
        sourceIds: [...new Set(rows.map((r) => r.sourceId))],
        targetIds: [...new Set(rows.map((r) => r.targetId))],
        templateIds: [],
        count: rows.length,
        provider: batch.provider,
        imageModel: batch.imageModel,
        productType: 'POD',
        research: '',
        researchSources: [],
        validateVisually: true,
        approvalMode: 'manual',
        pairs: rows,
        projectId: batch.projectId,
      },
      requestId,
    );
    return { done: false, run, ...(await this.batch(owner, id)) };
  }
  async precise(
    owner: string,
    input: {
      sourceId: string;
      template: Omit<MockupTemplate, keyof Entity | 'revision'>;
    },
  ) {
    const template = parse<Omit<MockupTemplate, keyof Entity | 'revision'>>(
      templateSchema,
      input.template,
    );
    if (this.rendering >= 2)
      throw new ApiError(
        429,
        'COMPOSITE_BUSY',
        'Đang ghép ảnh khác. Hãy thử lại sau.',
      );
    this.rendering++;
    try {
      const source = await this.assets.read(owner, input.sourceId),
        base = await this.assets.read(owner, template.assetId);
      const mask = template.maskAssetId
        ? await this.assets.read(owner, template.maskAssetId)
        : undefined;
      const overlay = template.overlayAssetId
        ? await this.assets.read(owner, template.overlayAssetId)
        : undefined;
      const buffer = await renderTemplate(
        base.buffer,
        source.buffer,
        {
          ...this.store.create<MockupTemplate>(owner, {
            ...template,
            revision: 1,
          }),
        },
        mask?.buffer,
        overlay?.buffer,
      );
      return publicAsset(
        await this.assets.save(owner, buffer, {
          name: `${template.name}_composite.png`,
          category: template.category,
          kind: 'result',
          parentId: source.asset.id,
          checks: {
            technical: true,
            visual: 'not_checked',
            notes: [
              'Ghép bằng phép biến đổi ảnh, không gọi AI vẽ lại. Cần duyệt vùng in/mask và phối cảnh.',
            ],
          },
        }),
      );
    } finally {
      this.rendering--;
    }
  }
  async exportImage(
    owner: string,
    id: string,
    preset: ExportPreset,
    sku: string,
  ) {
    if (this.rendering >= 2)
      throw new ApiError(
        429,
        'EXPORT_BUSY',
        'Đang xử lý file khác. Hãy thử lại sau.',
      );
    this.rendering++;
    try {
      return await this.transformExport(owner, id, preset, sku);
    } finally {
      this.rendering--;
    }
  }
  private async transformExport(
    owner: string,
    id: string,
    preset: ExportPreset,
    sku: string,
  ) {
    if (!skuValid(sku))
      throw new ApiError(400, 'EXPORT_SKU_INVALID', 'SKU không hợp lệ.');
    const { asset, buffer } = await this.assets.read(owner, id);
    if (preset.approvedOnly && asset.review !== 'approved')
      throw new ApiError(
        409,
        'EXPORT_REVIEW_REQUIRED',
        'Ảnh cần được duyệt trước khi xuất.',
      );
    if (preset.transparent) {
      const stats = await sharp(buffer, {
        limitInputPixels: 32_000_000,
      }).stats();
      if (stats.isOpaque)
        throw new ApiError(
          422,
          'EXPORT_TRANSPARENCY_REQUIRED',
          'Ảnh chưa có nền trong suốt. Cần tách nền/mask trước; preset không tự xóa nền.',
        );
    }
    const innerW = preset.width - 2 * preset.safeMargin,
      innerH = preset.height - 2 * preset.safeMargin;
    const png = await sharp(buffer, { limitInputPixels: 32_000_000 })
      .rotate()
      .resize(innerW, innerH, {
        fit: 'contain',
        background: {
          r: 255,
          g: 255,
          b: 255,
          alpha: preset.transparent ? 0 : 1,
        },
      })
      .extend({
        top: preset.safeMargin,
        bottom: preset.safeMargin,
        left: preset.safeMargin,
        right: preset.safeMargin,
        background: {
          r: 255,
          g: 255,
          b: 255,
          alpha: preset.transparent ? 0 : 1,
        },
      })
      .withMetadata({ density: preset.dpi })
      .png()
      .toBuffer();
    return {
      buffer: png,
      filename:
        safeFilename(`${sku}_${preset.name}_v${asset.revision}`).slice(0, 116) +
        '.png',
      manifest: {
        assetId: id,
        sku,
        preset,
        sourceWidth: asset.width,
        sourceHeight: asset.height,
        width: preset.width,
        height: preset.height,
        review: asset.review,
        upscaled: asset.width < innerW || asset.height < innerH,
        generatedAt: new Date().toISOString(),
        checks: asset.checks,
      },
    };
  }
}
