import { Injectable } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { externalServiceError } from '../common/external-service-error';

@Injectable()
export class R2Service {
  private client: S3Client;

  constructor(private readonly config: ConfigService) {
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

  async upload(buffer: Buffer, mime: string = 'image/png'): Promise<string> {
    const key = `mockups/${randomUUID()}.png`;

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
      throw externalServiceError('storage', error);
    }

    return `${this.config.get<string>('R2_PUBLIC_URL')}/${key}`;
  }
}
