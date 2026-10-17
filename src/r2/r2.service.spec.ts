import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { R2Service } from './r2.service';

describe('R2 generated image formats', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    [Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png', 'png'],
    [Buffer.from('ffd8ff00', 'hex'), 'image/jpeg', 'jpg'],
    [Buffer.from('524946460000000057454250', 'hex'), 'image/webp', 'webp'],
  ])(
    'detects output format when a Buffer-only image operation uploads to R2',
    async (image, mime, extension) => {
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
      await service.upload(image);
      const command = send.mock.calls[0][0] as PutObjectCommand;
      expect(command.input.ContentType).toBe(mime);
      expect(command.input.Key).toEqual(
        expect.stringMatching(new RegExp(`\\.${extension}$`)),
      );
    },
  );
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
        new RegExp(`^gemini-tools/mockups/[a-f0-9-]+\\.${extension}$`),
      );
      expect(url).toBe(`https://cdn.example/${command.input.Key}`);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('uses the configured namespace inside the shared bucket and returns a matching CDN URL', async () => {
    const send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    const service = new R2Service(
      new ConfigService({
        R2_PRIVATE_URL: 'https://storage.example',
        R2_ACCESS_KEY_ID: 'test',
        R2_SECRET_ACCESS_KEY: 'test',
        R2_BUCKET_NAME: 'shared-ezihubb-bucket',
        R2_KEY_PREFIX: 'apps/gemini-tools',
        R2_PUBLIC_URL: 'https://shared-cdn.example/',
      }),
    );
    const image = Buffer.from('ffd8ff00', 'hex');
    const url = await service.upload(image);
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command.input.Bucket).toBe('shared-ezihubb-bucket');
    expect(command.input.Key).toMatch(
      /^apps\/gemini-tools\/mockups\/[a-f0-9-]+\.jpg$/,
    );
    expect(command.input.ContentType).toBe('image/jpeg');
    expect(url).toBe(`https://shared-cdn.example/${command.input.Key}`);
    expect(url).not.toContain('.example//');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
