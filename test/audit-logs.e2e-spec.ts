import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { S3Client } from '@aws-sdk/client-s3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AuditModule } from '../src/audit/audit.module';
import { AuditLogService } from '../src/audit/audit-log.service';
import { BackgroundModule } from '../src/background/background.module';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { GeminiService } from '../src/gemini/gemini.service';
import { ShopAIKeyProvider } from '../src/ai/providers/shopaikey.provider';
import type { GoogleGenAI } from '@google/genai' with { 'resolution-mode': 'import' };

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
const result = {
  candidates: [
    {
      content: {
        parts: [
          {
            inlineData: { mimeType: 'image/png', data: png.toString('base64') },
          },
        ],
      },
    },
  ],
};
const generate = jest.fn(() => Promise.resolve(result));
class NativeGemini extends GeminiService {
  protected override createClient(): Promise<GoogleGenAI> {
    return Promise.resolve({
      models: { generateContent: generate },
    } as unknown as GoogleGenAI);
  }
}
class NativeShop extends ShopAIKeyProvider {
  protected override createClient(): Promise<GoogleGenAI> {
    return Promise.resolve({
      models: { generateContent: generate },
    } as unknown as GoogleGenAI);
  }
}

describe('Durable HTTP and AI diagnostics (no external calls)', () => {
  let directory: string;
  let app: INestApplication;
  let audit: AuditLogService;
  let send: jest.SpyInstance;
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-audit-e2e-'));
    const config = new ConfigService({
      AUDIT_LOG_DIR: directory,
      AI_PROVIDER: 'gemini',
      AI_AUTO_TEXT_ROUTING: false,
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL_IMAGE: 'gemini-3.1-flash-image',
      SHOPAIKEY_API_KEY: 'test-key',
      SHOPAIKEY_MODEL_IMAGE: 'gemini-3.1-flash-image-preview',
      R2_PRIVATE_URL: 'https://storage.example',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME: 'test',
      R2_PUBLIC_URL: 'https://cdn.example',
    });
    const module = await Test.createTestingModule({
      imports: [AuditModule, BackgroundModule],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(GeminiService)
      .useFactory({
        factory: (config: ConfigService, audit: AuditLogService) =>
          new NativeGemini(config, audit),
        inject: [ConfigService, AuditLogService],
      })
      .overrideProvider(ShopAIKeyProvider)
      .useFactory({
        factory: (config: ConfigService, audit: AuditLogService) =>
          new NativeShop(config, audit),
        inject: [ConfigService, AuditLogService],
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
    audit = app.get(AuditLogService);
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    jest.spyOn(global, 'fetch').mockImplementation((url, init) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            init?.method === 'POST'
              ? { data: [{ b64_json: png.toString('base64') }] }
              : {
                  models: [
                    { id: 'gemini-3.1-flash-image-preview' },
                    { id: 'gpt-image-1.5-all' },
                    { id: 'grok-imagine-image-2.0' },
                  ],
                },
          ),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
  });
  afterAll(async () => {
    if (app) await app.close();
    jest.restoreAllMocks();
    if (
      directory &&
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('gemini-audit-e2e-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => {
    generate.mockClear();
    send.mockClear();
  });
  const post = (
    instructions: string,
    provider = 'gemini',
    model?: string,
    source = png,
  ) => {
    let req = request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/api/backgrounds/replace')
      .field('provider', provider)
      .field('instructions', instructions);
    if (model) req = req.field('imageModel', model);
    return req
      .attach('productImage', source, {
        filename: 'source.png',
        contentType: 'image/png',
      })
      .attach('backgroundImage', jpeg, {
        filename: 'reference.jpg',
        contentType: 'image/jpeg',
      });
  };
  const events = async (id: string) => {
    await audit.flush();
    const raw = await fs.readFile(
      path.join(
        directory,
        new Date().toISOString().slice(0, 10),
        'events.jsonl',
      ),
      'utf8',
    );
    return raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.requestId === id);
  };
  it.each([
    ['gemini', undefined, 'gemini-3.1-flash-image'],
    [
      'shopaikey',
      'gemini-3.1-flash-image-preview',
      'gemini-3.1-flash-image-preview',
    ],
    ['shopaikey', 'gpt-image-1.5-all', 'gpt-image-1.5-all'],
    ['shopaikey', 'grok-imagine-image-2.0', 'grok-imagine-image-2.0'],
  ])(
    'correlates %s / %s with exact prompt, two images, output and R2 URL',
    async (provider, model, actualModel) => {
      const prompt = '  Thay ornament trong ẢNH 2.\r\nGiữ nguyên cảnh.  ';
      const res = await post(prompt, provider, model).expect(201);
      const id = res.headers['x-request-id'];
      expect(res.body).toMatchObject({
        requestId: id,
        url: expect.stringContaining('gemini-tools/mockups/') as unknown,
      });
      const records = await events(id);
      const ai = records.find((event) => event.event === 'ai_request');
      expect(ai).toMatchObject({ provider, model: actualModel });
      const parts = ai.parts as {
        text?: string;
        file?: string;
        type: string;
      }[];
      expect(parts.map((part) => part.type)).toEqual([
        'text',
        'image',
        'image',
      ]);
      expect(parts[0].text).toBe(prompt);
      expect(await fs.readFile(path.join(directory, parts[1].file))).toEqual(
        png,
      );
      expect(await fs.readFile(path.join(directory, parts[2].file))).toEqual(
        jpeg,
      );
      expect(
        records.find((event) => event.event === 'generated_image'),
      ).toBeDefined();
      expect(
        records.find((event) => event.event === 'storage_completed'),
      ).toMatchObject({ url: (res.body as { url: string }).url });
      expect(
        records.find((event) => event.event === 'http_completed'),
      ).toMatchObject({ status: 201, cancelled: false });
    },
  );

  it('logs validation failures with the same client-visible ID before generation', async () => {
    const res = await post('   ').expect(400);
    expect(res.body).toMatchObject({
      requestId: res.headers['x-request-id'],
    });
    const records = await events(res.headers['x-request-id']);
    expect(
      records.find((event) => event.event === 'http_completed'),
    ).toMatchObject({ status: 400 });
    expect(
      records.find((event) => event.event === 'ai_request'),
    ).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it('also journals errors that occur before interceptors', async () => {
    const missing = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get('/api/does-not-exist')
      .expect(404);
    const malformed = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .post('/api/backgrounds/replace')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    for (const res of [missing, malformed]) {
      expect(res.body).toMatchObject({
        requestId: res.headers['x-request-id'],
      });
      const records = await events(res.headers['x-request-id']);
      expect(records).toEqual([
        expect.objectContaining({
          event: 'http_completed',
          status: res.status,
        }),
      ]);
    }
  });

  it('retains model request and upstream error on AI failure', async () => {
    generate.mockRejectedValueOnce(
      Object.assign(
        new Error('Invalid API key: sk-audit12345678901234567890'),
        { status: 401 },
      ),
    );
    const res = await post('Prompt that fails upstream.').expect(502);
    const records = await events(res.headers['x-request-id']);
    expect(records.find((event) => event.event === 'ai_request')).toBeDefined();
    expect(
      records.find((event) => event.event === 'http_completed'),
    ).toMatchObject({
      status: 502,
      error: { provider: 'gemini', upstreamStatus: 401 },
    });
    expect(JSON.stringify(records)).not.toContain(
      'sk-audit12345678901234567890',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('archives generated bytes even when R2 rejects the upload, without regenerating', async () => {
    send.mockRejectedValueOnce({
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const res = await post('R2 failure.').expect(502);
    const records = await events(res.headers['x-request-id']);
    expect(
      records.find((event) => event.event === 'storage_failed'),
    ).toBeDefined();
    const image = records.find((event) => event.event === 'generated_image')
      .image as { file: string };
    expect(await fs.readFile(path.join(directory, image.file))).toEqual(png);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not mix images or prompts across concurrent requests', async () => {
    const responses = await Promise.all(
      [0, 1, 2].map((index) =>
        post(
          'Concurrent prompt ' + index,
          'gemini',
          undefined,
          Buffer.concat([png, Buffer.from([index])]),
        ).expect(201),
      ),
    );
    expect(
      new Set(responses.map((res) => res.headers['x-request-id'])).size,
    ).toBe(3);
    for (const [index, res] of responses.entries()) {
      const records = await events(res.headers['x-request-id']);
      const parts = records.find((event) => event.event === 'ai_request')
        .parts as { text?: string; file?: string }[];
      expect(parts[0].text).toBe('Concurrent prompt ' + index);
      expect(await fs.readFile(path.join(directory, parts[1].file))).toEqual(
        Buffer.concat([png, Buffer.from([index])]),
      );
    }
  });
});
