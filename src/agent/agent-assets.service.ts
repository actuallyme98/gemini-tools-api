import { Injectable, Optional } from '@nestjs/common';
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { ApiError } from '../common/api-error';
import { AgentStore } from './agent.store';
import type { Asset } from './agent.types';
import { imageMimeType } from '../utils/image.util';
import { R2Service } from '../r2/r2.service';
import { AuditLogService } from '../audit/audit-log.service';

export function safeFilename(name: string) {
  return (
    name
      .normalize('NFKC')
      .replace(/[\p{Cc}<>:"/\\|?*]/gu, '_')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 120) || 'image.png'
  );
}

@Injectable()
export class AgentAssetsService {
  private previewTail: Promise<unknown> = Promise.resolve();
  private previewCount = 0;
  constructor(
    private readonly store: AgentStore,
    private readonly r2: R2Service,
    private readonly config: ConfigService,
    @Optional() private readonly audit?: AuditLogService,
  ) {}
  async save(
    owner: string,
    buffer: Buffer,
    fields: Pick<Asset, 'name' | 'kind' | 'category'> &
      Partial<Pick<Asset, 'parentId' | 'runId' | 'stepId' | 'checks'>>,
  ) {
    if (buffer.length > 32 * 1024 * 1024 || !imageMimeType(buffer))
      throw new ApiError(
        400,
        'AGENT_IMAGE_INVALID',
        'Chỉ hỗ trợ ảnh PNG, JPEG, WebP hợp lệ, tối đa 32 MB.',
      );
    let info: sharp.Metadata;
    try {
      const decoder = sharp(buffer, {
        limitInputPixels: fields.runId ? 32_000_000 : 12_000_000,
        failOn: 'warning',
      });
      info = await decoder.metadata();
      if ((info.pages ?? 1) !== 1)
        throw new Error('Animated images unsupported');
      await decoder.stats();
    } catch {
      throw new ApiError(
        400,
        'AGENT_IMAGE_INVALID',
        fields.runId
          ? 'Ảnh kết quả không đọc được hoặc vượt giới hạn 32 megapixel.'
          : 'Ảnh không đọc được hoặc vượt giới hạn 12 megapixel.',
      );
    }
    const parent = fields.parentId
      ? await this.store.get<Asset>('asset', fields.parentId, owner)
      : undefined;
    if (fields.runId)
      await this.audit?.generatedImage(buffer, imageMimeType(buffer));
    const asset = this.store.create<Asset>(owner, {
      ...fields,
      name: safeFilename(fields.name),
      mimeType: imageMimeType(buffer),
      width: info.autoOrient?.width ?? info.width,
      height: info.autoOrient?.height ?? info.height,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      revision: (parent?.revision ?? 0) + 1,
      review: 'draft',
      storageKey: '',
      iv: '',
      tag: '',
    });
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(
        this.config.getOrThrow<string>('AGENT_ASSET_ENCRYPTION_KEY'),
        'hex',
      ),
      iv,
    );
    cipher.setAAD(Buffer.from(`${owner}:${asset.id}`));
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    asset.iv = iv.toString('hex');
    asset.tag = cipher.getAuthTag().toString('hex');
    try {
      asset.storageKey = await this.r2.putAgentObject(
        owner,
        asset.id,
        encrypted,
      );
    } catch {
      asset.storageKey = `mongo:${await this.store.backupImage(asset.id, encrypted)}`;
      await this.audit?.write('agent_storage_fallback', {
        assetId: asset.id,
        bytes: buffer.length,
      });
    }
    return this.store.insert('asset', asset);
  }
  async read(owner: string, id: string) {
    const asset = await this.store.get<Asset>('asset', id, owner);
    const encrypted = asset.storageKey.startsWith('mongo:')
      ? await this.store.readImageBackup(asset.storageKey.slice(6))
      : await this.r2.getAgentObject(asset.storageKey);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(
        this.config.getOrThrow<string>('AGENT_ASSET_ENCRYPTION_KEY'),
        'hex',
      ),
      Buffer.from(asset.iv, 'hex'),
    );
    decipher.setAAD(Buffer.from(`${owner}:${asset.id}`));
    decipher.setAuthTag(Buffer.from(asset.tag, 'hex'));
    return {
      asset,
      buffer: Buffer.concat([decipher.update(encrypted), decipher.final()]),
    };
  }
  async preview(owner: string, id: string) {
    await this.store.get<Asset>('asset', id, owner);
    if (this.previewCount >= 100)
      throw new ApiError(
        503,
        'AGENT_PREVIEW_BUSY',
        'Đang tải nhiều ảnh xem trước. Vui lòng thử lại.',
      );
    this.previewCount++;
    const task = this.previewTail
      .then(async () => {
        const { buffer } = await this.read(owner, id);
        return sharp(buffer, { limitInputPixels: 32_000_000 })
          .rotate()
          .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
      })
      .finally(() => this.previewCount--);
    this.previewTail = task.catch(() => undefined);
    return task;
  }
}
