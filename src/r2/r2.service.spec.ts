import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { R2Service } from './r2.service';

describe('R2 generated image formats', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
  ])(
    'stores %s with the matching download extension',
    async (mime, extension) => {
      const send = jest
        .spyOn(S3Client.prototype, 'send')
        .mockResolvedValue({} as never);
      const service = new R2Service(
        new ConfigService({
          R2_PRIVATE_URL: 'https://storage.example',
          R2_ACCESS_KEY_ID: 'test',
          R2_SECRET_ACCESS_KEY: 'test',
          R2_BUCKET_NAME: 'images',
          R2_PUBLIC_URL: 'https://cdn.example',
        }),
      );
      const image = Buffer.from('generated');
      const url = await service.upload(image, mime);
      const command = send.mock.calls[0][0] as PutObjectCommand;
      expect(command.input).toMatchObject({
        Bucket: 'images',
        Body: image,
        ContentType: mime,
      });
      expect(command.input.Key).toMatch(
        new RegExp(`^mockups/[a-f0-9-]+\\.${extension}$`),
      );
      expect(url).toBe(`https://cdn.example/${command.input.Key}`);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
});
