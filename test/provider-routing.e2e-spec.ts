import { TaskQueueService } from '../src/queue/task-queue.service';
import { AgentGuard } from '../src/agent/agent-auth.service';
import { queueFixture } from './queue-fixture';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  AI_PROVIDERS,
  AIProvider,
  AIProviderCatalog,
} from '../src/ai/ai-provider';
import { MockupModule } from '../src/mockup/mockup.module';
import { IdeaModule } from '../src/idea/idea.module';
import { BackgroundModule } from '../src/background/background.module';
import { R2Service } from '../src/r2/r2.service';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { externalServiceError } from '../src/common/external-service-error';
import { TextRouterService } from '../src/ai/text-router.service';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const analysis = {
  productCategory: '',
  productType: '',
  displayMode: 'product_only',
  primaryColors: [],
  pattern: '',
  styleKeywords: [],
  mood: '',
  audience: '',
  material: {
    main: '',
    details: '',
    texture: '',
    weightOrThickness: '',
    flexibility: '',
    breathability: '',
    seasonSuitability: [],
  },
};
const adapter = (id: string, capabilities: AIProvider['capabilities']) => ({
  ...(id === 'shopaikey'
    ? {
        getImageModels: jest.fn(() =>
          Promise.resolve({
            provider: id,
            defaultModel: 'gemini-3.1-flash-image-preview',
            models: [
              { id: 'gemini-3.1-flash-image-preview', name: 'Flash Image' },
              { id: 'gemini-3-pro-image-preview', name: 'Pro Image' },
            ],
          }),
        ),
      }
    : {}),
  id,
  name: id,
  capabilities,
  validateConfiguration: jest.fn(),
  generateJSON: jest.fn(
    (_prompt: string, image?: unknown): Promise<unknown> =>
      Promise.resolve(image ? analysis : ['scene']),
  ),
  generateImage: jest.fn(() => Promise.resolve(png)),
  editImage: jest.fn<Promise<Buffer>, [unknown]>().mockResolvedValue(png),
  generateImagesFromReferalImages: jest
    .fn<Promise<Buffer[]>, [unknown]>()
    .mockResolvedValue([png]),
  replaceBackground: jest
    .fn<Promise<{ buffer: Buffer; mimeType: string }>, [unknown]>()
    .mockResolvedValue({ buffer: png, mimeType: 'image/png' }),
});

describe('Client-selected provider routing', () => {
  let app: INestApplication;
  let queueEnv: Awaited<ReturnType<typeof queueFixture>>;
  const gemini = adapter('gemini', ['text', 'vision', 'image']);
  const textOnly = adapter('text-only', ['text']);
  const shopaikey = adapter('shopaikey', ['text', 'vision', 'image']);
  const offline = adapter('offline', ['text']);
  const upload = jest.fn(() =>
    Promise.resolve('https://cdn.example/result.png'),
  );
  const config = new ConfigService({ AI_AUTO_TEXT_ROUTING: false });
  const textRouter = {
    id: 'auto-text',
    name: 'VyceAI → ShopAIKey',
    capabilities: ['text'],
    validateConfiguration: jest.fn(),
    generateJSON: jest.fn(),
  };
  beforeAll(async () => {
    offline.validateConfiguration.mockImplementation(() => {
      throw new Error('secret API key');
    });
    queueEnv = await queueFixture(config);
    const module = await Test.createTestingModule({
      imports: [MockupModule, IdeaModule, BackgroundModule],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(TextRouterService)
      .useValue(textRouter)
      .overrideProvider(AI_PROVIDERS)
      .useValue([gemini, textOnly, shopaikey, offline])
      .overrideProvider(R2Service)
      .useValue({ upload })
      .overrideProvider(TaskQueueService)
      .useValue(queueEnv.queue)
      .overrideGuard(AgentGuard)
      .useValue(queueEnv.guard)
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
    await queueEnv.seed(app);
  });
  afterAll(async () => {
    await app?.close();
    await queueEnv?.close();
  });
  beforeEach(() => jest.clearAllMocks());
  const post = (
    endpoint: string,
    fields: Record<string, string>,
    provider?: string,
  ) => {
    let req = request(
      app.getHttpServer() as Parameters<typeof request>[0],
    ).post('/api/' + endpoint);
    for (const [key, value] of Object.entries(fields))
      req = req.field(key, value);
    if (provider !== undefined) req = req.field('provider', provider);
    if (endpoint === 'backgrounds/replace') {
      if (!Object.prototype.hasOwnProperty.call(fields, 'instructions'))
        req = req.field('instructions', 'Transfer artwork to the reference.');
      return req
        .attach('productImage', png, {
          filename: 'product.png',
          contentType: 'image/png',
        })
        .attach('backgroundImage', png, {
          filename: 'background.png',
          contentType: 'image/png',
        });
    }
    return req.attach(
      endpoint.endsWith('referal-images') ? 'productImage' : 'image',
      png,
      { filename: 'product.png', contentType: 'image/png' },
    );
  };
  it('serves safe routing metadata without invoking AI or storage', async () => {
    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get('/api/ai/providers')
      .expect(200);
    const catalog = res.body as AIProviderCatalog;
    expect(catalog.defaults).toEqual({
      text: 'shopaikey',
      vision: 'shopaikey',
      image: 'shopaikey',
    });
    expect(
      catalog.providers.find((entry) => entry.id === 'offline'),
    ).toMatchObject({
      available: false,
      capabilities: [],
    });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(gemini.generateJSON).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
  it('returns image model metadata and rejects unknown providers without generation', async () => {
    const response = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get('/api/ai/providers/shopaikey/image-models?refresh=true')
      .expect(200);
    expect(response.body).toMatchObject({
      provider: 'shopaikey',
      defaultModel: 'gemini-3.1-flash-image-preview',
      models: expect.any(Array) as unknown,
    });
    expect(shopaikey.getImageModels).toHaveBeenCalledWith(true);
    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .get('/api/ai/providers/unknown/image-models')
      .expect(400);
    expect(shopaikey.editImage).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
  it.each([
    ['mockups/generate-mockups', { prompts: '["edit"]' }, 'editImage'],
    ['ideas/generate-ideas', { basePrompt: 'studio', count: '1' }, 'editImage'],
    [
      'ideas/generate-images-from-referal-images',
      { variations: '2' },
      'generateImagesFromReferalImages',
    ],
    ['backgrounds/replace', {}, 'replaceBackground'],
  ] as [
    string,
    Record<string, string>,
    'editImage' | 'generateImagesFromReferalImages' | 'replaceBackground',
  ][])(
    'routes the selected image model for %s and rejects bad selections before paid work',
    async (endpoint, fields, method) => {
      const model = 'gemini-3-pro-image-preview';
      for (const imageModel of [
        'gemini-text-only',
        'https://untrusted.example',
        '',
        'a'.repeat(129),
      ])
        await post(endpoint, { ...fields, imageModel }, 'shopaikey').expect(
          400,
        );
      expect(shopaikey.generateJSON).not.toHaveBeenCalled();
      expect(shopaikey[method]).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      await post(endpoint, { ...fields, imageModel: model }, 'gemini').expect(
        400,
      );
      if (endpoint === 'ideas/generate-ideas')
        shopaikey.generateJSON.mockResolvedValueOnce([
          { title: 'studio', description: '', prompt: 'edit' },
        ]);
      await post(
        endpoint,
        { ...fields, imageModel: model },
        'shopaikey',
      ).expect(201);
      expect(shopaikey[method]).toHaveBeenCalledWith(
        expect.objectContaining({ imageModel: model }),
      );
      for (const call of shopaikey[method].mock.calls)
        expect(call[0]).toMatchObject({ imageModel: model });
      expect(gemini.editImage).not.toHaveBeenCalled();
    },
  );
  it('uses automatic text routing while keeping image processing on the selected ShopAIKey model', async () => {
    config.set('AI_AUTO_TEXT_ROUTING', true);
    try {
      textRouter.generateJSON.mockResolvedValueOnce([
        { title: 'studio', description: '', prompt: 'edit' },
      ]);
      await post(
        'ideas/generate-ideas',
        {
          count: '1',
          basePrompt: 'studio',
          imageModel: 'gemini-3-pro-image-preview',
        },
        'shopaikey',
      ).expect(201);
      expect(textRouter.generateJSON).toHaveBeenCalledTimes(1);
      expect(shopaikey.generateJSON).not.toHaveBeenCalled();
      expect(shopaikey.editImage).toHaveBeenCalledWith(
        expect.objectContaining({ imageModel: 'gemini-3-pro-image-preview' }),
      );
      const response = await request(
        app.getHttpServer() as Parameters<typeof request>[0],
      )
        .get('/api/ai/providers')
        .expect(200);
      expect(response.body).toMatchObject({
        textRouting: {
          primary: 'vyceai',
          fallback: 'shopaikey',
          healthRequired: true,
        },
      });
      expect(
        (response.body as AIProviderCatalog).providers.map((p) => p.id),
      ).not.toContain('vyceai');
    } finally {
      config.set('AI_AUTO_TEXT_ROUTING', false);
    }
  });
  it.each([
    ['mockups/generate-prompts', { count: '1' }],
    ['ideas/analyze-product', {}],
    ['mockups/generate-mockups', { prompts: '["edit"]' }],
    ['ideas/generate-ideas', { count: '1', basePrompt: 'summer' }],
    ['ideas/generate-images-from-referal-images', { variations: '1' }],
    ['backgrounds/replace', { variationIndex: '1' }],
  ] as [string, Record<string, string>][])(
    'rejects unsupported selections before any AI step on %s',
    async (endpoint, fields) => {
      await post(endpoint, fields, 'text-only').expect(400);
      expect(gemini.generateJSON).not.toHaveBeenCalled();
      expect(textOnly.generateJSON).not.toHaveBeenCalled();
      expect(gemini.editImage).not.toHaveBeenCalled();
      expect(shopaikey.editImage).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it('routes selected analysis and image editing, and keeps omitted selections at defaults', async () => {
    await post('ideas/analyze-product', {}, 'shopaikey').expect(201);
    await post(
      'mockups/generate-mockups',
      { prompts: '["edit"]' },
      'shopaikey',
    ).expect(201);
    await post(
      'ideas/generate-images-from-referal-images',
      { variations: '1' },
      'shopaikey',
    ).expect(201);
    expect(shopaikey.generateJSON).toHaveBeenCalledTimes(1);
    expect(shopaikey.editImage).toHaveBeenCalledTimes(1);
    expect(shopaikey.generateImagesFromReferalImages).toHaveBeenCalledTimes(1);
    expect(gemini.editImage).not.toHaveBeenCalled();
    await post('ideas/analyze-product', {}).expect(201);
    expect(shopaikey.generateJSON).toHaveBeenCalledTimes(2);
    expect(gemini.generateJSON).not.toHaveBeenCalled();
  });
  it('keeps selection through text generation and idea image generation', async () => {
    shopaikey.generateJSON.mockResolvedValueOnce([
      { title: 'idea', description: '', prompt: 'edit' },
    ]);
    await post(
      'ideas/generate-ideas',
      { count: '1', basePrompt: 'summer' },
      'shopaikey',
    ).expect(201);
    expect(shopaikey.generateJSON).toHaveBeenCalledTimes(1);
    expect(shopaikey.editImage).toHaveBeenCalledTimes(1);
    expect(gemini.generateJSON).not.toHaveBeenCalled();
    expect(gemini.editImage).not.toHaveBeenCalled();
  });
  it.each([
    ['ideas/analyze-product', {}],
    ['mockups/generate-prompts', { count: '1' }],
    ['mockups/generate-mockups', { prompts: '["edit"]' }],
    ['ideas/generate-ideas', { count: '1', basePrompt: 'summer' }],
    ['ideas/generate-images-from-referal-images', { variations: '1' }],
    ['backgrounds/replace', { variationIndex: '1' }],
  ] as [string, Record<string, string>][])(
    'rejects invalid/unconfigured selections before paid work on %s',
    async (endpoint, fields) => {
      for (const selected of [
        'unknown',
        'vyceai',
        'offline',
        '',
        'https://untrusted.example',
        'a'.repeat(65),
      ])
        await post(endpoint, fields, selected).expect(400);
      expect(gemini.generateJSON).not.toHaveBeenCalled();
      expect(gemini.editImage).not.toHaveBeenCalled();
      expect(gemini.generateImagesFromReferalImages).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['ideas/analyze-product', {}, 'generateJSON'],
    ['mockups/generate-prompts', { count: '1' }, 'generateJSON'],
    ['mockups/generate-mockups', { prompts: '["edit"]' }, 'editImage'],
    [
      'ideas/generate-ideas',
      { count: '1', basePrompt: 'summer' },
      'generateJSON',
    ],
    [
      'ideas/generate-images-from-referal-images',
      { variations: '1' },
      'generateImagesFromReferalImages',
    ],
    ['backgrounds/replace', { variationIndex: '1' }, 'replaceBackground'],
  ] as [
    string,
    Record<string, string>,
    (
      | 'generateJSON'
      | 'editImage'
      | 'generateImagesFromReferalImages'
      | 'replaceBackground'
    ),
  ][])(
    'returns actionable billing errors on %s without retrying or using another provider',
    async (endpoint, fields, method) => {
      gemini[method].mockRejectedValueOnce(
        Object.assign(
          new Error(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Lightning dunning decision is deny',
              },
            }),
          ),
          { status: 403 },
        ),
      );
      const response = await post(endpoint, fields, 'gemini').expect(503);
      expect(response.body).toMatchObject({
        statusCode: 503,
        code: 'AI_BILLING_BLOCKED',
        provider: 'gemini',
        upstreamStatus: 403,
        reason: 'Lightning dunning decision is deny',
        retryable: false,
        requestId: expect.any(String) as unknown,
      });
      expect(response.headers['x-request-id']).toBe(
        (response.body as { requestId: string }).requestId,
      );
      expect(gemini[method]).toHaveBeenCalledTimes(1);
      expect(shopaikey.generateJSON).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it('edits one reference photo using only the selected provider and stores the returned MIME type', async () => {
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
    shopaikey.replaceBackground.mockResolvedValueOnce({
      buffer: jpeg,
      mimeType: 'image/jpeg',
    });
    const response = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .post('/api/backgrounds/replace')
      .field('provider', 'shopaikey')
      .field('instructions', '  soft shadows  ')
      .field('variationIndex', '2')
      .attach('productImage', png, {
        filename: 'product.png',
        contentType: 'image/png',
      })
      .attach('backgroundImage', jpeg, {
        filename: 'scene.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    expect(shopaikey.replaceBackground).toHaveBeenCalledTimes(1);
    expect(shopaikey.replaceBackground).toHaveBeenCalledWith({
      productImage: { base64: png.toString('base64'), mimeType: 'image/png' },
      backgroundImage: {
        base64: jpeg.toString('base64'),
        mimeType: 'image/jpeg',
      },
      instructions: '  soft shadows  ',
      variationIndex: 2,
    });
    expect(upload).toHaveBeenCalledWith(jpeg, 'image/jpeg');
    expect(response.body).toMatchObject({
      url: 'https://cdn.example/result.png',
      mimeType: 'image/jpeg',
    });
    expect(gemini.replaceBackground).not.toHaveBeenCalled();
    expect(shopaikey.generateJSON).not.toHaveBeenCalled();
    expect(shopaikey.generateImagesFromReferalImages).not.toHaveBeenCalled();
  });
  it.each(['0', '4', '1.5', 'invalid'])(
    'rejects invalid background variations %s before generation',
    async (variationIndex) => {
      await post('backgrounds/replace', { variationIndex }, 'gemini').expect(
        400,
      );
      expect(gemini.replaceBackground).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it.each(['', '   \n\t', 'x'.repeat(12001)])(
    'rejects empty or oversized final prompts before paid work (%#)',
    async (instructions) => {
      await post('backgrounds/replace', { instructions }, 'gemini').expect(400);
      expect(gemini.replaceBackground).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it('accepts a complete prompt longer than the old limit and preserves its text', async () => {
    const instructions =
      '  Edit IMAGE 2.\n' + 'Preserve the source artwork. '.repeat(120) + '  ';
    await post('backgrounds/replace', { instructions }, 'gemini').expect(201);
    expect(gemini.replaceBackground).toHaveBeenCalledWith(
      expect.objectContaining({ instructions }),
    );
  });
  it('requires a final prompt instead of silently substituting a hidden base', async () => {
    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/api/backgrounds/replace')
      .attach('productImage', png, {
        filename: 'product.png',
        contentType: 'image/png',
      })
      .attach('backgroundImage', png, {
        filename: 'reference.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(gemini.replaceBackground).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
  it('names the missing background input and rejects corrupt reference images before paid work', async () => {
    const response = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .post('/api/backgrounds/replace')
      .field('instructions', 'Transfer artwork to the reference.')
      .attach('productImage', png, {
        filename: 'product.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(response.body).toMatchObject({
      message: 'Reference image is required',
      requestId: expect.any(String) as unknown,
    });
    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/api/backgrounds/replace')
      .field('instructions', 'Transfer artwork to the reference.')
      .attach('productImage', png, {
        filename: 'product.png',
        contentType: 'image/png',
      })
      .attach('backgroundImage', Buffer.from('invalid'), {
        filename: 'scene.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(gemini.replaceBackground).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
  it('does not regenerate a paid background image when storage rejects the upload', async () => {
    upload.mockRejectedValueOnce(
      externalServiceError('storage', {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    );
    const response = await post('backgrounds/replace', {}, 'gemini').expect(
      502,
    );
    expect(response.body).toMatchObject({
      code: 'STORAGE_ACCESS_DENIED',
      retryable: false,
    });
    expect(gemini.replaceBackground).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it('returns storage access errors after generation without repeating paid work', async () => {
    upload.mockRejectedValueOnce(
      externalServiceError('storage', {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    );
    const response = await post(
      'mockups/generate-mockups',
      { prompts: '["edit"]' },
      'gemini',
    ).expect(502);
    expect(response.body).toMatchObject({
      code: 'STORAGE_ACCESS_DENIED',
      upstreamStatus: 403,
      retryable: false,
    });
    expect(gemini.editImage).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
