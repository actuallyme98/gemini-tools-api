import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MockupModule } from '../src/mockup/mockup.module';
import { IdeaModule } from '../src/idea/idea.module';
import { AIService } from '../src/ai/ai.service';
import { R2Service } from '../src/r2/r2.service';
import { HealthController } from '../src/health.controller';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const analysis = {
  productCategory: 'apparel',
  productType: 'shirt',
  displayMode: 'product_only',
  primaryColors: ['white'],
  styleKeywords: ['minimal'],
  pattern: '',
  mood: '',
  audience: '',
  material: {
    main: 'cotton',
    details: '',
    texture: '',
    weightOrThickness: '',
    flexibility: '',
    breathability: '',
    seasonSuitability: [],
  },
};
const ai = {
  analyzeProductFromImage: jest.fn(() => Promise.resolve(analysis)),
  generateMockupPrompts: jest.fn((_analysis: unknown, count: number) =>
    Promise.resolve(Array.from({ length: count }, (_, i) => 'prompt ' + i)),
  ),
  generateIdeasFromAttributes: jest.fn((_prompt: string, count: number) =>
    Promise.resolve(
      Array.from({ length: count }, (_, i) => ({
        title: 'idea ' + i,
        description: '',
        prompt: 'edit ' + i,
      })),
    ),
  ),
  editImage: jest.fn(() => Promise.resolve(png)),
  generateImagesFromReferalImages: jest.fn(() => Promise.resolve([png, png])),
};
const r2 = {
  upload: jest.fn(() => Promise.resolve('https://cdn.example/result.png')),
};

describe('Image API contracts (no external services)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MockupModule, IdeaModule],
      controllers: [HealthController],
    })
      .overrideProvider(AIService)
      .useValue(ai)
      .overrideProvider(R2Service)
      .useValue(r2)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => jest.clearAllMocks());
  it('reports health without calling AI or storage', async () => {
    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok' });
    expect(ai.analyzeProductFromImage).not.toHaveBeenCalled();
    expect(r2.upload).not.toHaveBeenCalled();
  });
  const post = (endpoint: string) =>
    request(app.getHttpServer() as Parameters<typeof request>[0]).post(
      '/api/' + endpoint,
    );
  const attach = (req: ReturnType<typeof post>, field = 'image') =>
    req.attach(field, png, {
      filename: 'product.png',
      contentType: 'image/png',
    });
  it('accepts 12 prompts and returns an array', async () => {
    const res = await attach(
      post('mockups/generate-prompts').field('count', '12'),
    ).expect(201);
    expect(res.body).toHaveLength(12);
  });
  it.each(['0', '13', '3abc', '2.5'])(
    'rejects invalid prompt count %s before calling AI',
    async (count) => {
      await attach(
        post('mockups/generate-prompts').field('count', count),
      ).expect(400);
      expect(ai.analyzeProductFromImage).not.toHaveBeenCalled();
    },
  );
  it.each(['ideas/analyze-product', 'mockups/generate-prompts'])(
    'requires an image for %s',
    async (endpoint) => {
      await post(endpoint).field('count', '3').expect(400);
      expect(ai.analyzeProductFromImage).not.toHaveBeenCalled();
    },
  );
  it('rejects unsupported types, fake image headers and oversized files', async () => {
    await post('ideas/analyze-product')
      .attach('image', png, { filename: 'file.gif', contentType: 'image/gif' })
      .expect(400);
    await post('ideas/analyze-product')
      .attach('image', Buffer.from('fake'), {
        filename: 'file.png',
        contentType: 'image/png',
      })
      .expect(400);
    await post('ideas/analyze-product')
      .attach('image', Buffer.alloc(10 * 1024 * 1024 + 1), {
        filename: 'large.png',
        contentType: 'image/png',
      })
      .expect(413);
    expect(ai.analyzeProductFromImage).not.toHaveBeenCalled();
  });
  it.each(['bad json', '[" "]', JSON.stringify(Array(21).fill('edit'))])(
    'rejects malformed or excessive manual prompts',
    async (prompts) => {
      await attach(
        post('mockups/generate-mockups').field('prompts', prompts),
      ).expect(400);
      expect(ai.editImage).not.toHaveBeenCalled();
    },
  );
  it('generates and uploads one image per manual prompt', async () => {
    const res = await attach(
      post('mockups/generate-mockups').field('prompts', '["one","two"]'),
    ).expect(201);
    expect(res.body).toMatchObject({ total: 2 });
    expect(ai.editImage).toHaveBeenCalledTimes(2);
    expect(r2.upload).toHaveBeenCalledTimes(2);
  });
  it('uses the explicit idea count for text and image generation', async () => {
    const res = await attach(
      post('ideas/generate-ideas')
        .field('basePrompt', 'new ideas')
        .field('count', '2'),
    ).expect(201);
    expect(res.body).toHaveLength(2);
    expect(ai.generateIdeasFromAttributes).toHaveBeenCalledWith(
      'new ideas',
      2,
      undefined,
    );
    expect(ai.editImage).toHaveBeenCalledTimes(2);
  });
  it('generates exactly 3 reference variations with separate AI calls', async () => {
    const res = await attach(
      attach(
        post('ideas/generate-images-from-referal-images').field(
          'variations',
          '3',
        ),
        'productImage',
      ),
      'referenceImages',
    ).expect(201);
    expect(res.body).toHaveLength(3);
    expect(ai.generateImagesFromReferalImages).toHaveBeenCalledTimes(3);
    expect(r2.upload).toHaveBeenCalledTimes(3);
    expect(ai.generateImagesFromReferalImages.mock.calls).toHaveLength(3);
    expect(ai.generateImagesFromReferalImages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ variations: 1, variationIndex: 2 }),
      undefined,
    );
  });
  it.each(['0', '11', '2abc'])(
    'rejects invalid variation count %s',
    async (count) => {
      await attach(
        post('ideas/generate-images-from-referal-images').field(
          'variations',
          count,
        ),
        'productImage',
      ).expect(400);
      expect(ai.generateImagesFromReferalImages).not.toHaveBeenCalled();
    },
  );
  it('rejects more than 10 reference images', async () => {
    let req = attach(
      post('ideas/generate-images-from-referal-images'),
      'productImage',
    );
    for (let i = 0; i < 11; i++) req = attach(req, 'referenceImages');
    await req.expect(400);
    expect(ai.generateImagesFromReferalImages).not.toHaveBeenCalled();
  });
});
