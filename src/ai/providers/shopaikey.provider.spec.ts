import { ConfigService } from '@nestjs/config';
import type {
  GoogleGenAI,
  GoogleGenAIOptions,
} from '@google/genai' with { 'resolution-mode': 'import' };
import { ShopAIKeyProvider } from './shopaikey.provider';
import { GeminiService } from '../../gemini/gemini.service';

class TestShopAIKeyProvider extends ShopAIKeyProvider {
  readonly create = jest.fn();
  readonly options: GoogleGenAIOptions[] = [];
  protected override createClient(
    options: GoogleGenAIOptions,
  ): Promise<GoogleGenAI> {
    this.options.push(options);
    return Promise.resolve({
      models: { generateContent: this.create },
    } as unknown as GoogleGenAI);
  }
}

class TestGeminiProvider extends GeminiService {
  readonly create = jest.fn();
  readonly options: GoogleGenAIOptions[] = [];
  protected override createClient(
    options: GoogleGenAIOptions,
  ): Promise<GoogleGenAI> {
    this.options.push(options);
    return Promise.resolve({
      models: { generateContent: this.create },
    } as unknown as GoogleGenAI);
  }
}

function createProvider(config: Record<string, unknown> = {}) {
  return new TestShopAIKeyProvider(
    new ConfigService({
      SHOPAIKEY_API_KEY: 'test-shop-key',
      SHOPAIKEY_MODEL_IMAGE: 'native-image-model',
      ...config,
    }),
  );
}

const imageResponse = {
  candidates: [
    {
      content: {
        parts: [
          { text: 'Done' },
          {
            inlineData: {
              mimeType: 'image/png',
              data: Buffer.from('image').toString('base64'),
            },
          },
        ],
      },
    },
  ],
};

describe('ShopAIKey native GenAI provider', () => {
  it('uses separate API and Direct clients with ShopAIKey credentials', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    expect(provider.id).toBe('shopaikey');
    expect(provider.capabilities).toEqual(['text', 'vision', 'image']);
    expect(provider.options).toEqual([
      {
        apiKey: 'test-shop-key',
        httpOptions: {
          baseUrl: 'https://api.shopaikey.com',
          apiVersion: 'v1beta',
          headers: { Authorization: 'Bearer test-shop-key' },
          timeout: 60000,
        },
      },
      {
        apiKey: 'test-shop-key',
        httpOptions: {
          baseUrl: 'https://direct.shopaikey.com',
          apiVersion: 'v1beta',
          headers: { Authorization: 'Bearer test-shop-key' },
          timeout: 180000,
        },
      },
    ]);
  });

  it('honors custom endpoints and per-task timeouts', async () => {
    const provider = createProvider({
      SHOPAIKEY_BASE_URL: 'https://api.example',
      SHOPAIKEY_IMAGE_BASE_URL: 'https://direct.example',
      SHOPAIKEY_TIMEOUT_MS: 30000,
      SHOPAIKEY_IMAGE_TIMEOUT_MS: 240000,
    });
    await provider.onModuleInit();
    expect(provider.options[0].httpOptions).toMatchObject({
      baseUrl: 'https://api.example',
      timeout: 30000,
    });
    expect(provider.options[1].httpOptions).toMatchObject({
      baseUrl: 'https://direct.example',
      timeout: 240000,
    });
  });

  it('parses JSON text and uses a separate model for vision with inline image data', async () => {
    const provider = createProvider({
      SHOPAIKEY_MODEL_TEXT: 'text-model',
      SHOPAIKEY_MODEL_VISION: 'vision-model',
    });
    await provider.onModuleInit();
    provider.create.mockResolvedValue({
      candidates: [
        { content: { parts: [{ text: '```json\n["studio"]\n```' }] } },
      ],
    });
    expect(await provider.generateJSON('Prompts')).toEqual(['studio']);
    expect(provider.create).toHaveBeenLastCalledWith({
      model: 'text-model',
      contents: [{ role: 'user', parts: [{ text: 'Prompts' }] }],
    });
    await provider.generateJSON('Analyze', {
      base64: 'data:image/png;base64,aW1hZ2U=',
      mimeType: 'image/png',
    });
    expect(provider.create).toHaveBeenLastCalledWith({
      model: 'vision-model',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Analyze' },
            { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
          ],
        },
      ],
    });
  });

  it('generates and edits images using the image model and response modalities', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue(imageResponse);
    expect(await provider.generateImage('Studio product')).toEqual(
      Buffer.from('image'),
    );
    expect(provider.create).toHaveBeenLastCalledWith({
      model: 'native-image-model',
      contents: 'Studio product',
      config: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    expect(
      await provider.editImage({
        base64Image: 'data:image/png;base64,aW1hZ2U=',
        mimeType: 'image/png',
        prompt: 'New background',
      }),
    ).toEqual(Buffer.from('image'));
    expect(provider.create).toHaveBeenLastCalledWith({
      model: 'native-image-model',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'New background' },
            { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
          ],
        },
      ],
      config: { responseModalities: ['TEXT', 'IMAGE'] },
    });
  });

  it('sends the product first, preserves reference ordering, and extracts every returned image', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { data: 'b25l', mimeType: 'image/png' } },
              { inlineData: { data: 'dHdv', mimeType: 'image/png' } },
            ],
          },
        },
      ],
    });
    expect(
      await provider.generateImagesFromReferalImages({
        productImageBase64: 'data:image/png;base64,cHJvZHVjdA==',
        productMimeType: 'image/png',
        referenceImages: [
          { base64: 'data:image/jpeg;base64,cmVm', mimeType: 'image/jpeg' },
        ],
      }),
    ).toEqual([Buffer.from('one'), Buffer.from('two')]);
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [
          {
            role: 'user',
            parts: [
              expect.any(Object),
              expect.any(Object),
              { inlineData: { mimeType: 'image/png', data: 'cHJvZHVjdA==' } },
              expect.any(Object),
              { inlineData: { mimeType: 'image/jpeg', data: 'cmVm' } },
            ],
          },
        ],
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    );
  });

  it('requires only ShopAIKey credentials and requires an explicit image model', async () => {
    const missingKey = new TestShopAIKeyProvider(new ConfigService({}));
    await missingKey.onModuleInit();
    expect(missingKey.options).toEqual([]);
    expect(() => missingKey.validateConfiguration('text')).toThrow(
      'SHOPAIKEY_API_KEY',
    );
    const textOnly = new TestShopAIKeyProvider(
      new ConfigService({ SHOPAIKEY_API_KEY: 'test-shop-key' }),
    );
    expect(() => textOnly.validateConfiguration('text')).not.toThrow();
    expect(() => textOnly.validateConfiguration('vision')).not.toThrow();
    expect(() => textOnly.validateConfiguration('image')).toThrow(
      'SHOPAIKEY_MODEL_IMAGE',
    );
    expect(() => createProvider().validateConfiguration('image')).not.toThrow();
  });

  it.each([
    { candidates: [] },
    { candidates: [{ content: { parts: [{ text: 'No image' }] } }] },
  ])(
    'rejects missing images instead of returning undefined',
    async (response) => {
      const provider = createProvider();
      await provider.onModuleInit();
      provider.create.mockResolvedValue(response);
      await expect(provider.generateImage('Product')).rejects.toThrow(
        'No image returned from shopaikey',
      );
      await expect(
        provider.editImage({
          base64Image: 'aW1hZ2U=',
          mimeType: 'image/png',
          prompt: 'Product',
        }),
      ).rejects.toThrow('shopaikey');
      await expect(
        provider.generateImagesFromReferalImages({
          productImageBase64: 'aW1hZ2U=',
          productMimeType: 'image/png',
        }),
      ).rejects.toThrow('shopaikey');
    },
  );

  it('propagates upstream failures without performing its own paid retries', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockRejectedValue(new Error('Upstream timeout'));
    await expect(provider.generateImage('Product')).rejects.toThrow(
      'Upstream timeout',
    );
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('preserves direct Gemini credentials, model configuration and image requests', async () => {
    const provider = new TestGeminiProvider(
      new ConfigService({
        GEMINI_API_KEY: 'google-key',
        GEMINI_MODEL_TEXT: 'custom-text',
        GEMINI_MODEL_MULTIMODAL: 'custom-vision',
        GEMINI_MODEL_IMAGE: 'custom-image',
      }),
    );
    await provider.onModuleInit();
    expect(provider.options).toEqual([
      { apiKey: 'google-key' },
      { apiKey: 'google-key' },
    ]);
    provider.create.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: '["studio"]' }] } }],
    });
    await provider.generateJSON('Prompts');
    expect(provider.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'custom-text' }),
    );
    await provider.generateJSON('Analyze', {
      base64: 'aW1hZ2U=',
      mimeType: 'image/png',
    });
    expect(provider.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'custom-vision' }),
    );
    provider.create.mockResolvedValue(imageResponse);
    await provider.generateImage('Product');
    expect(provider.create).toHaveBeenLastCalledWith({
      model: 'custom-image',
      contents: 'Product',
    });
  });
});
