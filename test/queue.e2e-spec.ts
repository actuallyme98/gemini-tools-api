import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import Redis from 'ioredis';
import { ImageJobsModule } from '../src/common/image-jobs.module';
import { AgentModule } from '../src/agent/agent.module';
import { BackgroundModule } from '../src/background/background.module';
import { AIService } from '../src/ai/ai.service';
import { R2Service } from '../src/r2/r2.service';
import { AgentAuthService } from '../src/agent/agent-auth.service';
import { AgentStore } from '../src/agent/agent.store';
import { AgentWorker } from '../src/agent/agent.worker';
import { ImageJobsService } from '../src/common/image-jobs.service';
import { ImageJobsWorker } from '../src/common/image-jobs.worker';
import { TaskQueueService } from '../src/queue/task-queue.service';
import type { QueuedImageJob } from '../src/common/image-task';
import type { CompanySettings, Run, Step } from '../src/agent/agent.types';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { redisFixture } from './redis-fixture';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
jest.setTimeout(30000);
const wait = async (condition: () => Promise<boolean>, timeout = 12000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await sleep(30);
  }
  throw new Error('Queue condition did not become true');
};

describe('BullMQ with real Redis and MongoDB, isolated from production', () => {
  let mongo: MongoMemoryServer, redis: Awaited<ReturnType<typeof redisFixture>>;
  let api: INestApplication, worker: INestApplication, second: INestApplication;
  let owner: string, otherOwner: string, token: string, otherToken: string;
  const prefix = 'lcg-test-' + randomUUID();
  let active = 0,
    peak = 0;
  let release: (() => void) | undefined;
  let blocker: Promise<void> | undefined;
  const ai = {
    validateSelection: jest.fn(),
    validateImageModel: jest.fn().mockResolvedValue(undefined),
    agentJSON: jest.fn().mockImplementation((prompt: string) => {
      const data = JSON.parse(prompt.split('DỮ LIỆU:\n')[1]) as {
        tasks: unknown[];
      };
      return Promise.resolve({
        summary: 'Kế hoạch',
        questions: [],
        items: data.tasks.map(() => ({
          title: 'Thiết kế',
          prompt: 'Giữ thiết kế sản phẩm',
        })),
      });
    }),
    replaceBackground: jest.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        if (blocker !== undefined) await blocker;
        await sleep(60);
        return { buffer: png, mimeType: 'image/png' };
      } finally {
        active--;
      }
    }),
    editImage: jest.fn().mockResolvedValue(png),
  };
  const r2 = {
    upload: jest.fn().mockResolvedValue('https://cdn.example/result.png'),
  };
  const make = async (consume: boolean) => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [
            () => ({
              AGENT_ENABLED: true,
              QUEUE_ENABLED: true,
              QUEUE_WORKER_ENABLED: consume,
              REDIS_URL: redis.url,
              MONGODB_URI: mongo.getUri(),
              MONGODB_DATABASE: 'queue_test',
              AGENT_ASSET_ENCRYPTION_KEY: 'a'.repeat(64),
              QUEUE_PREFIX: prefix,
              QUEUE_CONCURRENCY: 3,
              QUEUE_USER_CONCURRENCY: 1,
              QUEUE_MAX_PENDING: 100,
              QUEUE_MAX_PENDING_PER_USER: 25,
              AGENT_CONCURRENCY: 3,
            }),
          ],
        }),
        ImageJobsModule,
        AgentModule,
        BackgroundModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    })
      .overrideProvider(AIService)
      .useValue(ai)
      .overrideProvider(R2Service)
      .useValue(r2)
      .compile();
    const app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
    return app;
  };
  const http = () => api.getHttpServer() as Parameters<typeof request>[0];
  const submit = (
    key = randomUUID(),
    auth = token,
    prompt = 'Thay sản phẩm bằng mẫu gốc',
  ) =>
    request(http())
      .post('/api/backgrounds/replace')
      .set('Authorization', `Bearer ${auth}`)
      .set('Idempotency-Key', key)
      .field('async', 'true')
      .field('instructions', prompt)
      .attach('productImage', png, {
        filename: 'source.png',
        contentType: 'image/png',
      })
      .attach('backgroundImage', png, {
        filename: 'target.png',
        contentType: 'image/png',
      });
  const status = (id: string, auth = token) =>
    request(http())
      .get('/api/image-jobs/' + id)
      .set('Authorization', `Bearer ${auth}`);
  const phase = async (id: string) =>
    (await status(id)).body as { state: string; phase: string };
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    redis = await redisFixture();
    api = await make(false);
    const auth = api.get(AgentAuthService);
    owner = (
      await auth.createUser(
        'one@example.com',
        'employee-password-one',
        'designer',
      )
    ).id;
    otherOwner = (
      await auth.createUser(
        'two@example.com',
        'employee-password-two',
        'designer',
      )
    ).id;
    token = (
      await auth.login('one@example.com', 'employee-password-one', 'one')
    ).token;
    otherToken = (
      await auth.login('two@example.com', 'employee-password-two', 'two')
    ).token;
  }, 120000);
  afterAll(async () => {
    release?.();
    blocker = undefined;
    await second?.close();
    await worker?.close();
    await api?.close();
    await redis?.close();
    await mongo?.stop();
  }, 120000);
  it('returns 202 without a worker, persists encrypted input and rejects foreign polling or ID reuse', async () => {
    const id = randomUUID();
    const first = await submit(id).expect(202);
    expect((first.body as { jobId: string }).jobId).toBe(id);
    await status(id, otherToken).expect(404);
    await submit(id, token, 'Nội dung khác với lần gửi đầu').expect(409);
    await submit(id, otherToken).expect(404);
    const duplicate = await submit(id).expect(202);
    expect((duplicate.body as { jobId: string }).jobId).toBe(id);
    expect(ai.replaceBackground).not.toHaveBeenCalled();
    const saved = await api
      .get(AgentStore)
      .get<QueuedImageJob>('image-job', id, owner);
    expect(JSON.stringify(saved)).not.toContain('Thay sản phẩm');
    const encrypted = await api
      .get(AgentStore)
      .readImageBackup(saved.payload.storageKey);
    expect(encrypted.toString('utf8')).not.toContain('Thay sản phẩm');
    const payload = await api.get(ImageJobsService).payload(saved);
    expect(payload.images).toHaveLength(2);
    expect(payload.prompt).toBe('Thay sản phẩm bằng mẫu gốc');
    await api.close();
    api = await make(false);
    await status(id).expect(200);
    worker = await make(true);
    await wait(async () => (await phase(id)).state === 'done');
    expect(ai.replaceBackground).toHaveBeenCalledTimes(1);
    await worker.get(ImageJobsWorker).process(id, owner);
    expect(ai.replaceBackground).toHaveBeenCalledTimes(1);
  });
  it('supports concurrent tabs and employees with global/per-user limits across two workers', async () => {
    second = await make(true);
    peak = 0;
    blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const idsA = Array.from({ length: 5 }, () => randomUUID());
    const idsB = Array.from({ length: 3 }, () => randomUUID());
    const responses = await Promise.all([
      ...idsA.map((id) => submit(id)),
      ...idsB.map((id) => submit(id, otherToken)),
    ]);
    expect(responses.every((response) => response.status === 202)).toBe(true);
    await wait(() => Promise.resolve(active === 2));
    const records = await api
      .get(AgentStore)
      .query<QueuedImageJob>('image-job', { state: 'running' }, 100);
    expect(records.filter((job) => job.owner === owner)).toHaveLength(1);
    expect(records.filter((job) => job.owner === otherOwner)).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(3);
    const redisClient = new Redis(redis.url);
    const keys = await redisClient.keys(`${prefix}:ai-work:*`);
    const samples: string[] = [];
    for (const key of keys)
      if ((await redisClient.type(key)) === 'hash')
        samples.push(JSON.stringify(await redisClient.hgetall(key)));
    expect(samples.join('')).not.toContain('base64');
    expect(samples.join('')).not.toContain('Thay sản phẩm');
    redisClient.disconnect();
    release?.();
    blocker = undefined;
    await wait(async () => {
      const states = await Promise.all(
        [...idsA, ...idsB].map((id) =>
          api.get(AgentStore).find<QueuedImageJob>('image-job', id),
        ),
      );
      return states.every((job) => job?.state === 'done');
    }, 20000);
    expect(peak).toBeLessThanOrEqual(3);
  });
  it('bounds the whole queue across four employees and enforces atomic admission across tabs', async () => {
    const auth = api.get(AgentAuthService);
    const extraTokens: string[] = [];
    for (const name of ['three', 'four']) {
      await auth.createUser(
        `${name}@example.com`,
        'employee-password-strong',
        'designer',
      );
      extraTokens.push(
        (
          await auth.login(
            `${name}@example.com`,
            'employee-password-strong',
            name,
          )
        ).token,
      );
    }
    blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    peak = 0;
    const ids = [token, otherToken, ...extraTokens].map((auth) => ({
      auth,
      id: randomUUID(),
    }));
    try {
      await Promise.all(
        ids.map(({ id, auth }) => submit(id, auth).expect(202)),
      );
      await wait(() => Promise.resolve(active === 3));
      await sleep(1100);
      expect(active).toBe(3);
      expect(peak).toBe(3);
    } finally {
      release?.();
      blocker = undefined;
    }
    await wait(async () => {
      const jobs = await Promise.all(
        ids.map(({ id }) =>
          api.get(AgentStore).find<QueuedImageJob>('image-job', id),
        ),
      );
      return jobs.every((job) => job?.state === 'done');
    });
    const queue = api.get(TaskQueueService);
    const admissionOwner = randomUUID();
    const reservations = Array.from({ length: 26 }, () => randomUUID());
    const results = await Promise.allSettled(
      reservations.map((id) => queue.reserve(id, admissionOwner)),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(25);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure.reason).toMatchObject({ status: 429 });
    await Promise.all(
      reservations.map((id) => queue.release(id, admissionOwner)),
    );
    await request(http()).post('/api/backgrounds/replace').expect(401);
    await request(http()).get('/api/image-jobs').expect(401);
  });
  it('recovers an unpublished MongoDB outbox and marks lost executions uncertain without calling AI again', async () => {
    const queue = api.get(TaskQueueService);
    const publish = jest
      .spyOn(queue, 'publish')
      .mockRejectedValueOnce(
        new Error('Redis disconnected after durable save'),
      );
    const id = randomUUID();
    await submit(id).expect(202);
    publish.mockRestore();
    await api.get(ImageJobsService).reconcile();
    await wait(async () => (await phase(id)).state === 'done');
    const store = api.get(AgentStore);
    const unknown = store.create<QueuedImageJob>(owner, {
      state: 'running',
      requestId: randomUUID(),
      inputHash: 'test',
      leaseUntil: Date.now() - 1000,
      workerId: 'dead',
      queueReleased: false,
    });
    await store.insert('image-job', unknown);
    const before = ai.replaceBackground.mock.calls.length;
    await worker.get(ImageJobsWorker).process(unknown.id, owner);
    await api.get(ImageJobsService).reconcile();
    expect(
      (await store.get<QueuedImageJob>('image-job', unknown.id, owner)).state,
    ).toBe('interrupted');
    expect(ai.replaceBackground.mock.calls.length).toBe(before);
  });
  it('pauses queued work company-wide and allows safe cancellation before submission', async () => {
    const store = api.get(AgentStore);
    const settings = store.create<CompanySettings>('', {
      name: 'Test',
      protectedAdminId: owner,
      googleAllowedDomains: [],
      googleAutoProvision: false,
      queuePaused: true,
    });
    settings.id = 'company';
    await store.ensure('company-settings', settings);
    const id = randomUUID();
    const before = ai.replaceBackground.mock.calls.length;
    await submit(id).expect(202);
    await sleep(1200);
    expect((await phase(id)).phase).toBe('queued');
    expect(ai.replaceBackground.mock.calls.length).toBe(before);
    await request(http())
      .post(`/api/image-jobs/${id}/cancel`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(http())
      .post(`/api/image-jobs/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    await store.patch<CompanySettings>('company-settings', 'company', '', {
      queuePaused: false,
    });
    await sleep(1200);
    expect(ai.replaceBackground.mock.calls.length).toBe(before);
  });
  it('dispatches Agent planning through the same BullMQ workers and preserves result prompts', async () => {
    const conversation = await request(http())
      .post('/api/agent/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Agent tab' })
      .expect(201);
    const id = randomUUID();
    await request(http())
      .post(
        `/api/agent/conversations/${(conversation.body as { id: string }).id}/messages`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send({ id, text: 'Thiết kế camping', operation: 'design', count: 2 })
      .expect(202);
    await api.get(AgentWorker).tick();
    await wait(
      async () =>
        (await api.get(AgentStore).find<Run>('run', id))?.state === 'draft',
    );
    const run = await api.get(AgentStore).find<Run>('run', id);
    expect(run.items).toHaveLength(2);
    await wait(async () => {
      const steps = await api
        .get(AgentStore)
        .query<Step>('step', { runId: id });
      return steps[0]?.state === 'done';
    });
  });
});
