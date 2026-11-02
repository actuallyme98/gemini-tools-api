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
  afterEach(() => jest.restoreAllMocks());

  it('analyzes ordered Studio images as vision, independently of the text model', async () => {
    const provider = createProvider({
      SHOPAIKEY_MODEL_VISION: 'test-vision',
      SHOPAIKEY_MODEL_TEXT: 'test-text',
    });
    await provider.onModuleInit();
    provider.create.mockResolvedValue({
      candidates: [
        { content: { parts: [{ text: '{"summary":"source and master"}' }] } },
      ],
    });
    await expect(
      provider.generateJSONImages('Observe source and master only', [
        { mimeType: 'image/png', base64: 'c291cmNl' },
        { mimeType: 'image/jpeg', base64: 'bWFzdGVy' },
      ]),
    ).resolves.toEqual({ summary: 'source and master' });
    expect(provider.create).toHaveBeenCalledWith({
      model: 'test-vision',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Observe source and master only' },
            { inlineData: { mimeType: 'image/png', data: 'c291cmNl' } },
            { inlineData: { mimeType: 'image/jpeg', data: 'bWFzdGVy' } },
          ],
        },
      ],
    });
  });

  it('forwards Studio final prompt and ordered source/master images without hidden transfer instructions', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue(imageResponse);
    const images = [
      { mimeType: 'image/png', base64: 'c291cmNl' },
      { mimeType: 'image/jpeg', base64: 'bWFzdGVy' },
    ];
    await expect(
      provider.composeImage({ prompt: 'FINAL STUDIO PROMPT', images }),
    ).resolves.toEqual(Buffer.from('image'));
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'FINAL STUDIO PROMPT' },
              { inlineData: { mimeType: 'image/png', data: images[0].base64 } },
              {
                inlineData: { mimeType: 'image/jpeg', data: images[1].base64 },
              },
            ],
          },
        ],
      }),
    );
  });

  it('converts native Markdown image output into bytes and retries only its download', async () => {
    const image = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(image));
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [{ text: '![image](https://image.chr1.com/generated.jpg)' }],
          },
        },
      ],
    });
    await expect(
      provider.editImage({
        base64Image: 'aW1hZ2U=',
        mimeType: 'image/png',
        prompt: 'Edit',
      }),
    ).resolves.toEqual(image);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION'])(
    'reports %s without trying to download or regenerate',
    async (finishReason) => {
      const fetcher = jest.spyOn(global, 'fetch');
      const provider = createProvider();
      await provider.onModuleInit();
      provider.create.mockResolvedValue({
        candidates: [
          {
            finishReason,
            content: {
              parts: [{ text: '![image](https://image.chr1.com/blocked.jpg)' }],
            },
          },
        ],
      });
      await expect(provider.generateImage('Edit')).rejects.toMatchObject({
        response: { code: 'AI_CONTENT_BLOCKED', reason: finishReason },
      });
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('uses a final image from later candidates and excludes thought images', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue({
      candidates: [
        { content: { parts: [{ text: 'Working' }] } },
        {
          content: {
            parts: [
              {
                thought: true,
                inlineData: { data: 'ZHJhZnQ=', mimeType: 'image/png' },
              },
              { inlineData: { data: 'ZmluYWw=', mimeType: 'image/png' } },
            ],
          },
        },
      ],
    });
    await expect(provider.generateImage('Edit')).resolves.toEqual(
      Buffer.from('final'),
    );
  });
  it('normalizes the live catalog, filters incompatible models, caches requests and supports refresh', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            apiKey: 'must-not-leak',
            data: [
              { id: 'gemini-3-pro-image-preview' },
              {
                name: 'models/gemini-3.1-flash-image-preview',
                displayName: 'Flash Image',
              },
              { id: 'gpt-image-1' },
              { id: 'gpt-image-1.5-all' },
              { id: 'grok-imagine-image-2.0' },
              { id: 'grok-4.6' },
              { id: 'gemini-2.5-flash' },
              { id: 'gemini-3.8-flash' },
              { id: 'gemini-4-argon' },
              { id: 'nano-banana-2.1' },
              { id: 'gemini-nano-banana-2.1' },
              { id: 'gemini-3-pro-image-preview' },
              { id: 'gemini-image/../../private' },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const provider = createProvider({
      SHOPAIKEY_MODEL_IMAGE: 'gemini-3.1-flash-image-preview',
    });
    const [catalog, concurrent] = await Promise.all([
      provider.getImageModels(),
      provider.getImageModels(),
    ]);
    expect(catalog).toEqual({
      provider: 'shopaikey',
      defaultModel: 'gemini-3.1-flash-image-preview',
      models: [
        {
          id: 'gemini-3-pro-image-preview',
          name: 'gemini-3-pro-image-preview',
        },
        { id: 'gemini-3.1-flash-image-preview', name: 'Flash Image' },
        { id: 'gemini-nano-banana-2.1', name: 'gemini-nano-banana-2.1' },
        { id: 'gpt-image-1', name: 'gpt-image-1' },
        { id: 'gpt-image-1.5-all', name: 'gpt-image-1.5-all' },
        { id: 'grok-imagine-image-2.0', name: 'grok-imagine-image-2.0' },
      ],
    });
    expect(concurrent).toEqual(catalog);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(catalog)).not.toContain('must-not-leak');
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://api.shopaikey.com/v1beta/models',
    );
    await provider.getImageModels();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await provider.getImageModels(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('routes the native Nano Banana 2.1 model through Gemini with both product and background inputs', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue(imageResponse);
    await provider.replaceBackground({
      productImage: { base64: 'cHJvZHVjdA==', mimeType: 'image/png' },
      backgroundImage: { base64: 'YmFja2dyb3VuZA==', mimeType: 'image/png' },
      imageModel: 'gemini-nano-banana-2.1',
      instructions: 'Transfer the artwork.',
    });
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-nano-banana-2.1',
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    );
    const request = provider.create.mock.calls[0] as [
      { contents: [{ parts: { inlineData?: { data: string } }[] }] },
    ];
    expect(
      request[0].contents[0].parts
        .filter((part) => part.inlineData)
        .map((part) => part.inlineData?.data),
    ).toEqual(['YmFja2dyb3VuZA==', 'cHJvZHVjdA==']);
  });
  it('keeps per-request image models independent and preserves the default', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue(imageResponse);
    const params = {
      base64Image: 'aW1hZ2U=',
      mimeType: 'image/png',
      prompt: 'edit',
    };
    await Promise.all([
      provider.editImage({ ...params, imageModel: 'first-image' }),
      provider.editImage({ ...params, imageModel: 'second-image' }),
    ]);
    expect(
      provider.create.mock.calls.map(
        (call) => (call as [{ model: string }])[0].model,
      ),
    ).toEqual(['first-image', 'second-image']);
    await provider.editImage(params);
    expect(provider.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'native-image-model' }),
    );
    await provider.generateImagesFromReferalImages({
      productImageBase64: 'aW1hZ2U=',
      productMimeType: 'image/png',
      imageModel: 'reference-image',
    });
    expect(provider.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'reference-image' }),
    );
    await provider.replaceBackground({
      productImage: { base64: 'aW1hZ2U=', mimeType: 'image/png' },
      backgroundImage: { base64: 'aW1hZ2U=', mimeType: 'image/png' },
      imageModel: 'background-image',
      instructions: 'Transfer the artwork.',
    });
    expect(provider.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'background-image' }),
    );
  });
  it('does not cache a failed catalog request', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"invalid api key"}}', {
          status: 401,
        }),
      )
      .mockResolvedValueOnce(new Response('{"models":[]}'));
    const provider = createProvider();
    await expect(provider.getImageModels()).rejects.toMatchObject({
      status: 401,
    });
    await expect(provider.getImageModels()).resolves.toMatchObject({
      models: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('sends the artwork source and base photo with distinct labels, preserving output MIME type', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: 'image/webp', data: 'aW1hZ2U=' } },
            ],
          },
        },
      ],
    });
    expect(
      await provider.replaceBackground({
        productImage: {
          base64: 'data:image/png;base64,cHJvZHVjdA==',
          mimeType: 'image/png',
        },
        backgroundImage: {
          base64: 'data:image/jpeg;base64,c2NlbmU=',
          mimeType: 'image/jpeg',
        },
        variationIndex: 2,
        instructions: 'Only edit the product on the left',
      }),
    ).toEqual({ buffer: Buffer.from('image'), mimeType: 'image/webp' });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.create).toHaveBeenCalledWith({
      model: 'native-image-model',
      config: { responseModalities: ['TEXT', 'IMAGE'] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Only edit the product on the left' },
            { inlineData: { mimeType: 'image/jpeg', data: 'c2NlbmU=' } },
            { inlineData: { mimeType: 'image/png', data: 'cHJvZHVjdA==' } },
          ],
        },
      ],
    });
  });
  it.each([
    [
      'Gemini',
      () =>
        new TestGeminiProvider(
          new ConfigService({ GEMINI_API_KEY: 'test-key' }),
        ),
    ],
    ['ShopAIKey native', () => createProvider()],
  ] as const)(
    '%s forwards the final edited prompt verbatim without hidden base rules or variation text',
    async (_name, create) => {
      const provider = create();
      await provider.onModuleInit();
      provider.create.mockResolvedValue(imageResponse);
      const instructions =
        '  Change the print size as requested.\nKeep this line and spacing.  ';
      await provider.replaceBackground({
        productImage: { base64: 'cHJvZHVjdA==', mimeType: 'image/png' },
        backgroundImage: { base64: 'c2NlbmU=', mimeType: 'image/png' },
        instructions,
        variationIndex: 3,
      });
      const request = provider.create.mock.calls[0] as [
        { contents: [{ parts: [{ text: string }] }] },
      ];
      expect(request[0].contents[0].parts).toEqual([
        { text: instructions },
        { inlineData: { mimeType: 'image/png', data: 'c2NlbmU=' } },
        { inlineData: { mimeType: 'image/png', data: 'cHJvZHVjdA==' } },
      ]);
    },
  );
  it('reports content safety blocks instead of a misleading invalid JSON or missing image error', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue({
      promptFeedback: { blockReason: 'SAFETY' },
    });
    await expect(provider.generateJSON('blocked')).rejects.toThrow(
      'từ chối nội dung',
    );
    await expect(provider.generateImage('blocked')).rejects.toThrow(
      'từ chối nội dung',
    );
  });
  it('reports truncated output instead of a JSON parsing failure', async () => {
    const provider = createProvider();
    await provider.onModuleInit();
    provider.create.mockResolvedValue({
      candidates: [
        {
          finishReason: 'MAX_TOKENS',
          content: { parts: [{ text: '{"unfinished":' }] },
        },
      ],
    });
    await expect(provider.generateJSON('long response')).rejects.toThrow(
      'bị cắt ngắn',
    );
  });
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
          timeout: 300000,
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
      await expect(provider.generateImage('Product')).rejects.toMatchObject({
        response: { code: 'AI_NO_IMAGE', retryable: false },
      });
      await expect(
        provider.editImage({
          base64Image: 'aW1hZ2U=',
          mimeType: 'image/png',
          prompt: 'Product',
        }),
      ).rejects.toMatchObject({ response: { code: 'AI_NO_IMAGE' } });
      await expect(
        provider.generateImagesFromReferalImages({
          productImageBase64: 'aW1hZ2U=',
          productMimeType: 'image/png',
        }),
      ).rejects.toMatchObject({ response: { code: 'AI_NO_IMAGE' } });
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
