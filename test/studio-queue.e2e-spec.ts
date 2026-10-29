import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import sharp from 'sharp';
import { StudioModule } from '../src/studio/studio.module';
import { StudioService } from '../src/studio/studio.service';
import { StudioWorker } from '../src/studio/studio.worker';
import { StudioOperationsService } from '../src/studio/studio-operations.service';
import { StudioMockupService } from '../src/studio/studio-mockup.service';
import type {
  StudioMockup,
  StudioMockupSlot,
} from '../src/studio/studio-mockup.types';
import { AgentStore } from '../src/agent/agent.store';
import { AgentAuthService } from '../src/agent/agent-auth.service';
import { TaskQueueService } from '../src/queue/task-queue.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { AIService } from '../src/ai/ai.service';
import { R2Service } from '../src/r2/r2.service';
import { redisFixture } from './redis-fixture';
import type { AgentUser } from '../src/agent/agent.types';
import type {
  IdeaInput,
  StudioTicket,
  StudioSlot,
  StudioOccurrence,
  StudioBatch,
} from '../src/studio/studio.types';

jest.setTimeout(60000);
async function until(predicate: () => Promise<boolean>) {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Studio queue condition timed out');
}
describe('Studio scheduler and BullMQ (real local Redis/Mongo, mocked AI only)', () => {
  let mongo: MongoMemoryServer, redis: Awaited<ReturnType<typeof redisFixture>>;
  let api: INestApplication,
    first: INestApplication | undefined,
    second: INestApplication | undefined;
  let admin: AgentUser, sellers: AgentUser[], input: IdeaInput;
  const prefix = 'studio-queue-' + randomUUID();
  const blobs = new Map<string, Buffer>();
  let png: Buffer,
    active = 0,
    peak = 0;
  const auditScope = new AsyncLocalStorage<{ owner?: string }>();
  const activeOwners = new Map<string, number>(),
    peakOwners = new Map<string, number>();
  let releaseRender!: () => void;
  const renderGate = new Promise<void>((resolve) => {
    releaseRender = resolve;
  });
  const ai = {
    validateImageModel: jest.fn().mockResolvedValue(undefined),
    analyzeStudioImages: jest.fn().mockResolvedValue({
      summary: 'Idea and master',
      invariants: ['Motif'],
      editable: ['Composition'],
      sourceArtifacts: [],
      risks: [],
    }),
    agentJSON: jest.fn().mockResolvedValue({
      briefs: [1, 2].map((index) => ({
        title: `Concept ${index}`,
        direction: 'Creative',
        composition: 'Balanced',
        palette: 'Warm',
        prompt: `Create standalone image concept ${index}, preserve master geometry.`,
      })),
    }),
    composeImage: jest.fn(async () => {
      const owner = auditScope.getStore()?.owner ?? 'missing';
      activeOwners.set(owner, (activeOwners.get(owner) ?? 0) + 1);
      peakOwners.set(
        owner,
        Math.max(peakOwners.get(owner) ?? 0, activeOwners.get(owner)),
      );
      active++;
      peak = Math.max(peak, active);
      if (active === 2) releaseRender();
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            renderGate,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      'Two independent owners did not execute concurrently',
                    ),
                  ),
                12000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        return png;
      } finally {
        active--;
        activeOwners.set(owner, activeOwners.get(owner) - 1);
      }
    }),
  };
  async function make(consume: boolean) {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [
            () => ({
              AGENT_ENABLED: true,
              STUDIO_ENABLED: true,
              STUDIO_SCHEDULER_ENABLED: true,
              QUEUE_ENABLED: true,
              QUEUE_WORKER_ENABLED: consume,
              QUEUE_PREFIX: prefix,
              QUEUE_CONCURRENCY: 2,
              QUEUE_USER_CONCURRENCY: 1,
              QUEUE_MAX_PENDING: 100,
              QUEUE_MAX_PENDING_PER_USER: 20,
              REDIS_URL: redis.url,
              MONGODB_URI: mongo.getUri(),
              MONGODB_DATABASE: 'studio_queue_test',
              AGENT_ASSET_ENCRYPTION_KEY: 'b'.repeat(64),
            }),
          ],
        }),
        StudioModule,
      ],
    })
      .overrideProvider(AIService)
      .useValue(ai)
      .overrideProvider(R2Service)
      .useValue({
        putAgentObject: (_owner: string, id: string, buffer: Buffer) => {
          blobs.set(id, buffer);
          return Promise.resolve(id);
        },
        getAgentObject: (id: string) => Promise.resolve(blobs.get(id)),
      })
      .overrideProvider(AuditLogService)
      .useValue({
        run: (context: { owner?: string }, callback: () => unknown) =>
          auditScope.run(context, callback),
        write: jest.fn().mockResolvedValue(undefined),
      })
      .compile();
    const app = module.createNestApplication({ logger: false });
    await app.init();
    return app;
  }
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    redis = await redisFixture();
    png = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#f58216' },
    })
      .png()
      .toBuffer();
    api = await make(false);
    const auth = api.get(AgentAuthService),
      store = api.get(AgentStore),
      studio = api.get(StudioService);
    const users: AgentUser[] = [];
    for (const [name, role] of [
      ['admin', 'admin'],
      ['seller1', 'admin'],
      ['seller2', 'admin'],
    ] as const) {
      const user = await auth.createUser(
        `${name}@queue.test`,
        'studio-queue-password',
        role,
      );
      users.push(await store.find<AgentUser>('user', user.id));
    }
    [admin, ...sellers] = users;
    const team = await studio.saveTeam(admin, undefined, {
      name: 'Queue team',
      members: sellers.map((seller) => ({
        userId: seller.id,
        role: 'seller' as const,
      })),
      archived: false,
    });
    const product = await studio.saveResource(admin, {
      teamId: team.id,
      type: 'product',
      name: 'Product',
      code: 'P01',
      instructions: 'Printed product',
      printSpec: { width: 128, height: 64, dpi: 300, background: 'white' },
    });
    const skill = await studio.saveResource(admin, {
      teamId: team.id,
      type: 'skill',
      name: 'Creative',
      code: 'SK',
      instructions: 'Distinct compositions.',
    });
    await studio.approveResource(admin, skill.id, skill.revision, 'approved');
    const master = await studio.assets.save(admin.id, png, {
      kind: 'template',
      category: 'POD',
      name: 'Master.png',
    });
    const thumbnail = await studio.saveResource(admin, {
      teamId: team.id,
      type: 'thumbnail',
      name: 'Master',
      code: 'M01',
      assetId: master.id,
      instructions: 'Keep geometry',
    });
    const shop = await studio.saveStore(admin, undefined, {
      teamId: team.id,
      name: 'Store',
      sellerIds: sellers.map((seller) => seller.id),
      productIds: [product.id],
      archived: false,
    });
    input = {
      title: 'Night selection',
      storeId: shop.id,
      productId: product.id,
      skillId: skill.id,
      thumbnailId: thumbnail.id,
      sourceId: '',
      sourceUrl: '',
      brief: 'Redesign two distinct product images.',
      count: 2,
      artworkFirst: true,
      timing: 'night',
      provider: 'shopaikey',
      imageModel: 'test-image',
    };
  });
  afterAll(async () => {
    await first?.close();
    await second?.close();
    await api?.close();
    await redis?.close();
    await mongo?.stop();
  });
  async function select(seller: AgentUser) {
    const studio = api.get(StudioService);
    const source = await studio.assets.save(seller.id, png, {
      kind: 'source',
      category: 'POD',
      name: 'Idea.png',
    });
    const idea = await studio.saveIdea(seller, undefined, {
      ...input,
      sourceId: source.id,
    });
    const pending = await studio.submit(seller, idea.id, idea.revision);
    return studio.decide(admin, idea.id, pending.revision, 'approved', '');
  }
  it('recovers approval and publish gaps across restart, dispatches one nightly batch and never repeats completed calls', async () => {
    const selections = await Promise.all(sellers.map(select));
    const store = api.get(AgentStore),
      studio = api.get(StudioService);
    await Promise.all(
      selections.flatMap((idea) => [
        studio.ensureTicket(idea),
        studio.ensureTicket(idea),
      ]),
    );
    expect(
      await store.query<StudioOccurrence>('studio-occurrence', {}),
    ).toHaveLength(1);
    expect(await store.query<StudioBatch>('studio-batch', {})).toHaveLength(1);
    const tickets = await store.query<StudioTicket>('studio-ticket', {});
    const due = Date.parse(tickets[0].dueAt);
    await store.remove('studio-ticket', selections[0].ticketId);
    await Promise.all([
      api.get(StudioWorker).tick(new Date(due + 1000)),
      api.get(StudioWorker).tick(new Date(due + 1000)),
    ]);
    const publish = jest
      .spyOn(api.get(TaskQueueService), 'publish')
      .mockRejectedValueOnce(new Error('simulate Redis publish interruption'));
    await expect(api.get(StudioWorker).tick()).rejects.toThrow();
    publish.mockRestore();
    expect(
      (await store.query('studio-plan', { state: 'queued' })).length,
    ).toBeGreaterThan(0);
    await api.close();
    api = await make(false);
    first = await make(true);
    second = await make(true);
    await until(async () =>
      (
        await api.get(AgentStore).query<StudioTicket>('studio-ticket', {})
      ).every((ticket) => ticket.state === 'review'),
    );
    expect(ai.composeImage).toHaveBeenCalledTimes(8);
    expect(ai.analyzeStudioImages).toHaveBeenCalledTimes(2);
    expect(ai.agentJSON).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    expect(peakOwners.size).toBe(2);
    expect([...peakOwners.values()].every((count) => count === 1)).toBe(true);
    const slots = await api
      .get(AgentStore)
      .query<StudioSlot>('studio-slot', {});
    expect(slots).toHaveLength(8);
    expect(new Set(slots.map((slot) => slot.resultId)).size).toBe(8);
    await first.close();
    first = await make(true);
    for (const slot of slots)
      await api
        .get(TaskQueueService)
        .publish({ kind: 'studio', id: slot.id, owner: slot.owner });
    await api.get(StudioWorker).tick(new Date(due + 86400000));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ai.composeImage).toHaveBeenCalledTimes(8);
    const batches = await api.get(StudioOperationsService).batches(1);
    expect(batches.items).toHaveLength(1);
    expect(batches.items[0].ticketCount).toBe(2);
    expect(batches.items[0].states.review).toBe(2);
  });
  it('runs Team mockup combinations on the same real queue and preserves completed outputs across worker restart', async () => {
    const studio = api.get(StudioService),
      mockups = api.get(StudioMockupService),
      store = api.get(AgentStore);
    const { resources, stores } = await studio.bootstrap(admin);
    const master = resources.find((r) => r.type === 'thumbnail');
    const scene = await studio.saveResource(admin, {
      teamId: stores[0].teamId,
      type: 'scene',
      name: 'Scene',
      code: 'SC01',
      instructions: 'Keep scene',
      assetId: master.assetId,
    });
    await studio.approveResource(admin, scene.id, 1, 'approved');
    const before = ai.composeImage.mock.calls.length;
    const jobs: StudioMockup[] = [];
    for (const seller of sellers) {
      const source = await studio.assets.save(seller.id, png, {
        kind: 'source',
        category: 'POD',
        name: 'Original.png',
      });
      jobs.push(
        await mockups.create(seller, {
          requestKey: randomUUID(),
          title: 'Queue mockup',
          storeId: stores[0].id,
          productId: input.productId,
          sources: [
            { assetId: source.id, sceneIds: [scene.id], colors: ['', 'black'] },
          ],
          provider: 'shopaikey',
          imageModel: 'test-image',
          instructions: '',
        }),
      );
    }
    await until(async () =>
      (await store.query<StudioMockup>('studio-mockup', {})).every(
        (j) => j.state === 'review',
      ),
    );
    expect(ai.composeImage.mock.calls.length - before).toBe(4);
    const slots = await store.query<StudioMockupSlot>('studio-mockup-slot', {});
    expect(slots).toHaveLength(4);
    expect(new Set(slots.map((s) => s.resultId)).size).toBe(4);
    await first.close();
    first = await make(true);
    for (const slot of slots)
      await api
        .get(TaskQueueService)
        .publish({ kind: 'studio-mockup', id: slot.id, owner: slot.owner });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ai.composeImage.mock.calls.length - before).toBe(4);
    expect([...peakOwners.values()].every((count) => count === 1)).toBe(true);
    expect(jobs.every((j) => j.count === 2)).toBe(true);
  });
});
