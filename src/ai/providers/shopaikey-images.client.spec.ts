import { ConfigService } from '@nestjs/config';
import { ShopAIKeyProvider } from './shopaikey.provider';
import { ShopAIKeyImagesClient } from './shopaikey-images.client';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
  'base64',
);
const original = { mimeType: 'image/png', base64: png.toString('base64') };
const reference = {
  mimeType: 'image/jpeg',
  base64: 'data:image/jpeg;base64,/9j/AA==',
};
const config = () =>
  new ConfigService({
    SHOPAIKEY_API_KEY: 'test-key',
    SHOPAIKEY_MODEL_IMAGE: 'gemini-3.1-flash-image-preview',
  });
const response = (image = png) =>
  new Response(
    JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }),
  );

describe('ShopAIKey GPT and Grok image editing', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['gpt-image-1.5-all', 'grok-imagine-image-2.0'])(
    'sends a real multipart source image with the exact selected model %s',
    async (model) => {
      const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(response());
      const result = await new ShopAIKeyImagesClient(config()).generate(
        model,
        'Keep the product',
        [original],
      );
      expect(result).toEqual({ buffer: png, mimeType: 'image/png' });
      const [url, options] = fetcher.mock.calls[0];
      expect(url).toBe('https://direct.shopaikey.com/v1/images/edits');
      expect(options?.headers).toEqual({ Authorization: 'Bearer test-key' });
      const form = options?.body as FormData;
      expect(form.get('model')).toBe(model);
      expect(form.get('prompt')).toBe('Keep the product');
      expect(form.get('n')).toBe('1');
      expect(form.get('response_format')).toBe('b64_json');
      const file = form.get('image') as File;
      expect(file.type).toBe('image/png');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the product first, all references distinct and background instructions intact across existing tools', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(response()));
    const provider = new ShopAIKeyProvider(config());
    await provider.replaceBackground({
      productImage: original,
      backgroundImage: reference,
      instructions: 'soft shadows',
      variationIndex: 2,
      imageModel: 'gpt-image-1.5-all',
    });
    const background = fetcher.mock.calls[0][1]?.body as FormData;
    expect(background.get('model')).toBe('gpt-image-1.5-all');
    expect(background.get('prompt')).toEqual(
      expect.stringContaining('soft shadows'),
    );
    expect(background.get('prompt')).toEqual(
      expect.stringContaining('Variation 2'),
    );
    const files = background.getAll('image[]') as File[];
    expect(files).toHaveLength(2);
    expect(Buffer.from(await files[0].arrayBuffer())).toEqual(png);
    expect(Buffer.from(await files[1].arrayBuffer())).toEqual(
      Buffer.from('/9j/AA==', 'base64'),
    );
    expect(files[1].type).toBe('image/jpeg');
    expect(background.get('image')).toBeNull();
    await provider.generateImagesFromReferalImages({
      productImageBase64: original.base64,
      productMimeType: original.mimeType,
      referenceImages: [reference],
      variationIndex: 3,
      imageModel: 'grok-imagine-image-2.0',
    });
    const edit = fetcher.mock.calls[1][1]?.body as FormData;
    expect(edit.get('model')).toBe('grok-imagine-image-2.0');
    expect(edit.get('prompt')).toEqual(expect.stringContaining('variation 3'));
    expect(edit.getAll('image[]')).toHaveLength(2);
    await provider.editImage({
      base64Image: original.base64,
      mimeType: original.mimeType,
      prompt: 'Custom edit',
      imageModel: 'gpt-image-1-mini',
    });
    const mockup = fetcher.mock.calls[2][1]?.body as FormData;
    expect(mockup.get('prompt')).toBe('Custom edit');
    expect(mockup.get('model')).toBe('gpt-image-1-mini');
  });

  it('generates one text-only image through the generation endpoint', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(response());
    const provider = new ShopAIKeyProvider(config());
    await expect(
      provider.generateImage('A blue box', 'gpt-image-1'),
    ).resolves.toEqual(png);
    expect(fetcher).toHaveBeenCalledWith(
      'https://direct.shopaikey.com/v1/images/generations',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt: 'A blue box',
          n: 1,
          response_format: 'b64_json',
          output_format: 'png',
        }),
      }),
    );
  });

  it('keeps concurrent model selections independent and honors a GPT default', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(response()));
    const provider = new ShopAIKeyProvider(
      new ConfigService({
        SHOPAIKEY_API_KEY: 'test-key',
        SHOPAIKEY_MODEL_IMAGE: 'gpt-image-1.5-all',
      }),
    );
    await Promise.all(
      ['gpt-image-1', 'grok-imagine-image-2.0'].map((imageModel) =>
        provider.editImage({
          base64Image: original.base64,
          mimeType: original.mimeType,
          prompt: 'edit',
          imageModel,
        }),
      ),
    );
    await provider.editImage({
      base64Image: original.base64,
      mimeType: original.mimeType,
      prompt: 'default',
    });
    expect(
      fetcher.mock.calls.map(([, options]) =>
        (options?.body as FormData).get('model'),
      ),
    ).toEqual(['gpt-image-1', 'grok-imagine-image-2.0', 'gpt-image-1.5-all']);
  });

  it('rejects too many Grok references before calling a paid endpoint', async () => {
    const fetcher = jest.spyOn(global, 'fetch');
    await expect(
      new ShopAIKeyImagesClient(config()).generate(
        'grok-imagine-image-2.0',
        'edit',
        Array.from({ length: 6 }, () => original),
      ),
    ).rejects.toMatchObject({
      response: { code: 'AI_INPUT_IMAGE_LIMIT', retryable: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['image/png', png],
    ['image/jpeg', Buffer.from('ffd8ff00', 'hex')],
    ['image/webp', Buffer.from('524946460000000057454250', 'hex')],
  ])('preserves actual %s output bytes and MIME', async (mimeType, image) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response(image));
    await expect(
      new ShopAIKeyImagesClient(config()).generate('gpt-image-1', 'edit', [
        original,
      ]),
    ).resolves.toEqual({ buffer: image, mimeType });
  });

  it.each([
    {},
    { data: [] },
    { data: [{ b64_json: '!!!' }] },
    { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] },
    { data: [{ url: 'http://127.0.0.1/private' }] },
  ])(
    'rejects missing, invalid or unexpected URL output without making a download request',
    async (payload) => {
      const fetcher = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(payload)));
      await expect(
        new ShopAIKeyImagesClient(config()).generate('gpt-image-1', 'edit', [
          original,
        ]),
      ).rejects.toThrow(/AI provider returned/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('retains the upstream error and never substitutes another model or transport', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message:
              'No available channel for model grok-imagine-image-2.0 under group cheap',
          },
        }),
        { status: 503 },
      ),
    );
    const provider = new ShopAIKeyProvider(config());
    await expect(
      provider.replaceBackground({
        productImage: original,
        backgroundImage: original,
        imageModel: 'grok-imagine-image-2.0',
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('No available channel') as unknown,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
