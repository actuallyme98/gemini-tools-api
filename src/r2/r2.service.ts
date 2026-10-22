import { Injectable, Optional } from '@nestjs/common';
import { AuditLogService } from '../audit/audit-log.service';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { externalServiceError } from '../common/external-service-error';
import { imageMimeType } from '../utils/image.util';

@Injectable()
export class R2Service {
  private client: S3Client;
  private readonly keyPrefix: string;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly audit?: AuditLogService,
  ) {
    this.keyPrefix = this.config.get<string>('R2_KEY_PREFIX', 'gemini-tools');
    this.client = new S3Client({
      region: 'auto',
      endpoint:
        this.config.get<string>('R2_PRIVATE_URL') ||
        `https://${this.config.get<string>('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.config.get<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: this.config.get<string>('R2_SECRET_ACCESS_KEY'),
      },
    });
  }

  async putAgentObject(
    owner: string,
    id: string,
    encrypted: Buffer,
  ): Promise<string> {
    const key = `${this.keyPrefix}/agent/${owner}/${id}.bin`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.get<string>('R2_BUCKET_NAME'),
          Key: key,
          Body: encrypted,
          ContentType: 'application/octet-stream',
          CacheControl: 'private, no-store',
        }),
      );
    } catch (error) {
      throw externalServiceError('storage', error);
    }
    return key;
  }

  async getAgentObject(key: string): Promise<Buffer> {
    if (!key.startsWith(`${this.keyPrefix}/agent/`))
      throw new Error('Invalid agent object key');
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.get<string>('R2_BUCKET_NAME'),
          Key: key,
        }),
      );
      if (
        !response.Body ||
        !response.ContentLength ||
        response.ContentLength > 32 * 1024 * 1024
      )
        throw new Error('Invalid agent object size');
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      throw externalServiceError('storage', error);
    }
  }

  async upload(
    buffer: Buffer,
    mime: string = imageMimeType(buffer) || 'image/png',
  ): Promise<string> {
    const extension =
      mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const key = `${this.keyPrefix}/mockups/${randomUUID()}.${extension}`;
    await this.audit?.generatedImage(buffer, mime);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.get<string>('R2_BUCKET_NAME'),
          Key: key,
          Body: buffer,
          ContentType: mime,
        }),
      );
    } catch (error) {
      const failure = externalServiceError('storage', error);
      await this.audit?.write('storage_failed', {
        key,
        error: failure.getResponse(),
      });
      throw failure;
    }

    const publicUrl = this.config
      .get<string>('R2_PUBLIC_URL')
      .replace(/\/+$/, '');
    const url = `${publicUrl}/${key}`;
    await this.audit?.write('storage_completed', { key, url, mimeType: mime });
    return url;
  }
}
