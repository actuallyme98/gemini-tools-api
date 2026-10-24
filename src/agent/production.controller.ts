import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import * as Joi from 'joi';
import { AgentGuard, type AgentRequest } from './agent-auth.service';
import { AgentDatabaseFilter } from './agent-database.filter';
import { ProductionService } from './production.service';
import { ResearchService } from './research.service';
import { WorkspaceService } from './workspace.service';
import { idSchema, parse, templateSchema } from './agent.schemas';
import { type ExportPreset } from './production.util';
import type { Entity, Asset, Run, Step } from './agent.types';
import type { EvaluationCase, EvaluationResult } from './workspace.types';
import { publicAsset } from './agent.service';
import { ApiError } from '../common/api-error';
import { createHash } from 'node:crypto';

const uuid = (value: string) => parse<string>(idSchema.required(), value);
const mapping = Joi.object({
  sku: Joi.string().max(120).required(),
  sourceId: Joi.string().max(120).required(),
  targetId: Joi.string().max(120).required(),
  prompt: Joi.string().max(120).required(),
}).required();
const csvInput = Joi.object({
  csv: Joi.string().max(1000000).required(),
  mapping,
});
export const exportPresetSchema = Joi.object({
  name: Joi.string().trim().min(1).max(60).required(),
  width: Joi.number().integer().min(32).max(8000).required(),
  height: Joi.number().integer().min(32).max(8000).required(),
  dpi: Joi.number().integer().min(72).max(600).default(300),
  transparent: Joi.boolean().default(false),
  safeMargin: Joi.number().integer().min(0).max(2000).default(0),
  approvedOnly: Joi.boolean().default(true),
}).custom((v: ExportPreset, h) =>
  v.width * v.height > 32_000_000 ||
  v.safeMargin * 2 >= Math.min(v.width, v.height)
    ? h.error('any.invalid')
    : v,
);
@Controller('agent/production')
@UseGuards(AgentGuard)
@UseFilters(AgentDatabaseFilter)
export class ProductionController {
  constructor(
    private readonly production: ProductionService,
    private readonly research: ResearchService,
    private readonly workspace: WorkspaceService,
  ) {}
  @Post('batches/preview') preview(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    const input = parse<{
      csv: string;
      mapping: Record<'sku' | 'sourceId' | 'targetId' | 'prompt', string>;
    }>(csvInput, body);
    return this.production.preview(req.agentUser.id, input.csv, input.mapping);
  }
  @Header('Cache-Control', 'no-store') @Get('batches') batches(
    @Req() req: AgentRequest,
  ) {
    return this.workspace.store.list('batch', req.agentUser.id, 100);
  }
  @Post('batches') createBatch(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    return this.production.createBatch(
      req.agentUser,
      parse(
        csvInput.keys({
          name: Joi.string().trim().min(1).max(120).required(),
          provider: Joi.string()
            .valid('shopaikey', 'gemini')
            .default('shopaikey'),
          imageModel: Joi.string().max(180),
          projectId: idSchema,
        }),
        body,
      ),
    );
  }
  @Header('Cache-Control', 'no-store') @Get('batches/:id') batch(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.production.batch(req.agentUser.id, uuid(id));
  }
  @Post('batches/:id/submit') submit(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.production.submit(
      req.agentUser.id,
      uuid(id),
      req.headers['x-request-id']?.toString().slice(0, 100) ?? 'batch-submit',
    );
  }
  @Post('composite') composite(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    return this.production.precise(
      req.agentUser.id,
      parse(
        Joi.object({
          sourceId: idSchema.required(),
          template: templateSchema.required(),
        }),
        body,
      ),
    );
  }
  @Header('Cache-Control', 'no-store') @Get('presets') presets(
    @Req() req: AgentRequest,
  ) {
    return this.workspace.store.list('export-preset', req.agentUser.id);
  }
  @Post('presets') preset(@Req() req: AgentRequest, @Body() body: unknown) {
    const input = parse<ExportPreset>(exportPresetSchema, body);
    return this.workspace.store.insert(
      'export-preset',
      this.workspace.store.create<ExportPreset & Entity>(
        req.agentUser.id,
        input,
      ),
    );
  }
  @Post('exports') async exportImage(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    const input = parse<{ assetId: string; sku: string; preset: ExportPreset }>(
      Joi.object({
        assetId: idSchema.required(),
        sku: Joi.string().max(80).required(),
        preset: exportPresetSchema.required(),
      }),
      body,
    );
    const result = await this.production.exportImage(
      req.agentUser.id,
      input.assetId,
      input.preset,
      input.sku,
    );
    const asset = await this.workspace.store.get<Asset>(
      'asset',
      input.assetId,
      req.agentUser.id,
    );
    const saved = await this.production.saveExport(
      req.agentUser.id,
      result.buffer,
      {
        name: result.filename,
        category: asset.category,
        kind: 'design',
        parentId: asset.id,
      },
    );
    return { asset: publicAsset(saved), manifest: result.manifest };
  }
  @Header('Cache-Control', 'no-store') @Get('research') researchList(
    @Req() req: AgentRequest,
  ) {
    return this.workspace.store.list('research', req.agentUser.id, 100);
  }
  @Post('research') runResearch(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    const input = parse<{ keyword: string; urls: string[] }>(
      Joi.object({
        keyword: Joi.string().trim().min(2).max(200).required(),
        urls: Joi.array()
          .items(
            Joi.string()
              .uri({ scheme: ['https'] })
              .max(2048),
          )
          .max(5)
          .unique()
          .default([]),
      }),
      body,
    );
    return this.research.create(req.agentUser.id, input.keyword, input.urls);
  }
  @Header('Cache-Control', 'no-store') @Get('evaluations') async evaluations(
    @Req() req: AgentRequest,
  ) {
    return {
      cases: await this.workspace.store.list<EvaluationCase>(
        'evaluation-case',
        req.agentUser.id,
      ),
      results: await this.workspace.store.list<EvaluationResult>(
        'evaluation-result',
        req.agentUser.id,
        500,
      ),
    };
  }
  @Post('evaluations') async createEvaluation(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    const input = parse<Omit<EvaluationCase, keyof Entity>>(
      Joi.object({
        name: Joi.string().trim().min(1).max(120).required(),
        sourceId: idSchema.required(),
        targetId: idSchema,
        requirements: Joi.string().min(3).max(8000).required(),
        expectedCount: Joi.number().integer().min(1).max(100).required(),
      }),
      body,
    );
    for (const id of [input.sourceId, input.targetId].filter(Boolean))
      await this.workspace.store.get<Asset>('asset', id, req.agentUser.id);
    return this.workspace.store.insert(
      'evaluation-case',
      this.workspace.store.create<EvaluationCase>(req.agentUser.id, input),
    );
  }
  @Post('evaluations/:id/results') async result(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<{ runId: string; score: number; notes: string }>(
      Joi.object({
        runId: idSchema.required(),
        score: Joi.number().min(0).max(100).required(),
        notes: Joi.string().min(3).max(4000).required(),
      }),
      body,
    );
    const test = await this.workspace.store.get<EvaluationCase>(
      'evaluation-case',
      uuid(id),
      req.agentUser.id,
    );
    const run = await this.workspace.store.get<Run>(
      'run',
      input.runId,
      req.agentUser.id,
    );
    if (
      !run.sourceIds.includes(test.sourceId) ||
      (test.targetId && !run.targetIds.includes(test.targetId)) ||
      !['review', 'completed', 'partial_failed', 'failed'].includes(run.state)
    )
      throw new ApiError(
        400,
        'EVALUATION_RUN_INVALID',
        'Chọn công việc đã chạy với đúng bộ ảnh của ca kiểm thử.',
      );
    const steps = await this.workspace.store.query<Step>(
      'step',
      { owner: run.owner, runId: run.id },
      25,
    );
    const cost = await this.workspace.costs(run, steps);
    return this.workspace.store.insert(
      'evaluation-result',
      this.workspace.store.create<EvaluationResult>(req.agentUser.id, {
        caseId: test.id,
        runId: run.id,
        model: run.imageModel ?? run.provider,
        promptHash: createHash('sha256')
          .update(JSON.stringify(run.items.map((i) => i.prompt)))
          .digest('hex'),
        score: input.score,
        notes: input.notes,
        durationMs: steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
        currency: cost.currency,
        costUsd: cost.costUsd,
        unresolved: cost.unresolved,
      }),
    );
  }
}
