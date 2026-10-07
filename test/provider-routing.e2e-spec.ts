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
import { R2Service } from '../src/r2/r2.service';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { externalServiceError } from '../src/common/external-service-error';

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
  id,
  name: id,
  capabilities,
  validateConfiguration: jest.fn(),
  generateJSON: jest.fn(
    (_prompt: string, image?: unknown): Promise<unknown> =>
      Promise.resolve(image ? analysis : ['scene']),
  ),
  generateImage: jest.fn(() => Promise.resolve(png)),
  editImage: jest.fn(() => Promise.resolve(png)),
  generateImagesFromReferalImages: jest.fn(() => Promise.resolve([png])),
});

describe('Client-selected provider routing', () => {
  let app: INestApplication;
  const gemini = adapter('gemini', ['text', 'vision', 'image']);
  const vyceai = adapter('vyceai', ['text']);
  const shopaikey = adapter('shopaikey', ['text', 'vision', 'image']);
  const offline = adapter('offline', ['text']);
  const upload = jest.fn(() =>
    Promise.resolve('https://cdn.example/result.png'),
  );
  beforeAll(async () => {
    offline.validateConfiguration.mockImplementation(() => {
      throw new Error('secret API key');
    });
    const module = await Test.createTestingModule({
      imports: [MockupModule, IdeaModule],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({}))
      .overrideProvider(AI_PROVIDERS)
      .useValue([gemini, vyceai, shopaikey, offline])
      .overrideProvider(R2Service)
      .useValue({ upload })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });
  afterAll(async () => app.close());
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
      text: 'gemini',
      vision: 'gemini',
      image: 'gemini',
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
  it.each([
    ['mockups/generate-prompts', { count: '1' }],
    ['ideas/analyze-product', {}],
    ['mockups/generate-mockups', { prompts: '["edit"]' }],
    ['ideas/generate-ideas', { count: '1', basePrompt: 'summer' }],
    ['ideas/generate-images-from-referal-images', { variations: '1' }],
  ] as [string, Record<string, string>][])(
    'rejects unsupported selections before any AI step on %s',
    async (endpoint, fields) => {
      await post(endpoint, fields, 'vyceai').expect(400);
      expect(gemini.generateJSON).not.toHaveBeenCalled();
      expect(vyceai.generateJSON).not.toHaveBeenCalled();
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
    expect(gemini.generateJSON).toHaveBeenCalledTimes(1);
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
  ] as [string, Record<string, string>][])(
    'rejects invalid/unconfigured selections before paid work on %s',
    async (endpoint, fields) => {
      for (const selected of [
        'unknown',
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
  ] as [
    string,
    Record<string, string>,
    'generateJSON' | 'editImage' | 'generateImagesFromReferalImages',
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
