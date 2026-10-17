import { Injectable, Optional } from '@nestjs/common';
import { AuditLogService } from '../audit/audit-log.service';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
