import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AgentStore } from '../agent/agent.store';
import { ApiError } from '../common/api-error';
import type { StudioBundle } from './studio.types';
import { studioHash } from './studio.util';

@Injectable()
export class StudioBundleService {
  constructor(
    private readonly store: AgentStore,
    private readonly config: ConfigService,
  ) {}
  async save(owner: string, teamId: string, buffer: Buffer) {
    const record = this.store.create<StudioBundle>(owner, {
      teamId,
      gridId: '',
      iv: '',
      tag: '',
      bytes: buffer.length,
      sha256: studioHash(buffer),
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
    cipher.setAAD(Buffer.from(`studio-bundle:${owner}:${record.id}`));
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    record.iv = iv.toString('hex');
    record.tag = cipher.getAuthTag().toString('hex');
    // GridFS already supports streaming backups; ZIPs may exceed the private image object's 32MB limit.
    record.gridId = await this.store.backupImage(record.id, encrypted);
    try {
      return await this.store.insert('studio-bundle', record);
    } catch (error) {
      await this.store.deleteImageBackup(record.gridId).catch(() => undefined);
      throw error;
    }
  }
  async read(id: string) {
    const record = await this.store.find<StudioBundle>('studio-bundle', id);
    if (!record)
      throw new ApiError(
        404,
        'STUDIO_BUNDLE_NOT_FOUND',
        'Không có ZIP gốc cho phiên bản này.',
      );
    const encrypted = await this.store.readImageBackup(
      record.gridId,
      50 * 1024 * 1024,
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(
        this.config.getOrThrow<string>('AGENT_ASSET_ENCRYPTION_KEY'),
        'hex',
      ),
      Buffer.from(record.iv, 'hex'),
    );
    decipher.setAAD(Buffer.from(`studio-bundle:${record.owner}:${record.id}`));
    decipher.setAuthTag(Buffer.from(record.tag, 'hex'));
    const buffer = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    if (buffer.length !== record.bytes || studioHash(buffer) !== record.sha256)
      throw new ApiError(
        503,
        'STUDIO_BUNDLE_CORRUPTED',
        'ZIP gốc không khớp dữ liệu lưu trữ.',
      );
    return buffer;
  }
}
