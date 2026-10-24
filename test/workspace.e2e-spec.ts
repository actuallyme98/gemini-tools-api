import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { AgentStore } from '../src/agent/agent.store';
import { AgentAuthService, AgentGuard } from '../src/agent/agent-auth.service';
import { AgentAssetsService } from '../src/agent/agent-assets.service';
import { AgentService } from '../src/agent/agent.service';
import { WorkspaceService } from '../src/agent/workspace.service';
import { WorkspaceController } from '../src/agent/workspace.controller';
import { ProductionService } from '../src/agent/production.service';
import { ProductionController } from '../src/agent/production.controller';
import { ResearchService } from '../src/agent/research.service';
import { TaskQueueService } from '../src/queue/task-queue.service';
import { TestTaskQueue } from './queue-fixture';
import { AIService } from '../src/ai/ai.service';
import { R2Service } from '../src/r2/r2.service';
import { retrieveKnowledge } from '../src/agent/knowledge';
import type { AgentUser, Asset, Run, Step } from '../src/agent/agent.types';
import type { Knowledge } from '../src/agent/workspace.types';

describe('Company workspace (real MongoDB, no paid model calls)', () => {
  let mongo: MongoMemoryServer,
    app: INestApplication,
    store: AgentStore,
    service: WorkspaceService,
    production: ProductionService;
  let owner: AgentUser,
    reviewer: AgentUser,
    viewer: AgentUser,
    outsider: AgentUser;
  let ownerToken: string,
    reviewerToken: string,
    viewerToken: string,
    outsiderToken: string,
    projectId: string,
    run: Run,
    source: Asset,
    target: Asset,
    result: Asset;
  const blobs = new Map<string, Buffer>();
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const module = await Test.createTestingModule({
      controllers: [WorkspaceController, ProductionController],
      providers: [
        AgentStore,
        AgentAuthService,
        AgentGuard,
        AgentAssetsService,
        AgentService,
        WorkspaceService,
        ProductionService,
        ResearchService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            AGENT_ENABLED: true,
            QUEUE_ENABLED: false,
            MONGODB_URI: mongo.getUri(),
            AGENT_ASSET_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
          }),
        },
        { provide: TaskQueueService, useValue: new TestTaskQueue() },
        {
          provide: AIService,
          useValue: {
            validateSelection: jest.fn(),
            validateImageModel: jest.fn(() => Promise.resolve()),
          },
        },
        {
          provide: R2Service,
          useValue: {
            putAgentObject: (owner: string, id: string, buffer: Buffer) => {
              blobs.set(id, buffer);
              return Promise.resolve(id);
            },
            getAgentObject: (id: string) => Promise.resolve(blobs.get(id)),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' });
    app.setGlobalPrefix('api');
    await app.init();
    store = app.get(AgentStore);
    service = app.get(WorkspaceService);
    production = app.get(ProductionService);
    const auth = app.get(AgentAuthService);
    for (const [email, role] of [
      ['owner@example.com', 'admin'],
      ['reviewer@example.com', 'designer'],
      ['viewer@example.com', 'designer'],
      ['outsider@example.com', 'designer'],
    ] as const)
      await auth.createUser(email, 'workspace-test-password', role);
    [owner, reviewer, viewer, outsider] = await Promise.all(
      ['owner', 'reviewer', 'viewer', 'outsider'].map(
        async (email) =>
          (
            await store.query<AgentUser>(
              'user',
              { email: `${email}@example.com` },
              1,
            )
          )[0],
      ),
    );
    [ownerToken, reviewerToken, viewerToken, outsiderToken] = await Promise.all(
      [owner, reviewer, viewer, outsider].map(
        async (user) =>
          (
            await auth.login(
              user.email,
              'workspace-test-password',
              randomUUID(),
            )
          ).token,
      ),
    );
    const project = await service.saveProject(owner, undefined, {
      name: 'Christmas',
      description: 'POD',
      members: [
        { email: reviewer.email, role: 'reviewer' },
        { email: viewer.email, role: 'viewer' },
      ],
      archived: false,
    });
    projectId = project.id;
    const assets = app.get(AgentAssetsService),
      png = await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: { r: 240, g: 100, b: 20, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
    source = await assets.save(owner.id, png, {
      name: 'source.png',
      kind: 'source',
      category: 'POD',
    });
    target = await assets.save(owner.id, png, {
      name: 'target.png',
      kind: 'reference',
      category: 'POD',
    });
    const conversation = await app
      .get(AgentService)
      .createConversation(owner.id, 'Test');
    run = store.create<Run>(owner.id, {
      conversationId: conversation.id,
      brief: 'Keep scene and design',
      operation: 'mockup_ai',
      state: 'review',
      provider: 'shopaikey',
      sourceIds: [source.id],
      targetIds: [target.id],
      templateIds: [],
      count: 1,
      productType: 'Ornament',
      research: '',
      researchSources: [],
      summary: 'Test',
      questions: [],
      items: [
        {
          title: 'Test',
          prompt: 'Replace product',
          sourceId: source.id,
          targetId: target.id,
        },
      ],
      analyses: {},
      validateVisually: false,
      requestId: randomUUID(),
      projectId,
      reviewerId: reviewer.id,
    });
    await store.insert('run', run);
    result = await assets.save(owner.id, png, {
      name: 'result.png',
      kind: 'result',
      category: 'POD',
      runId: run.id,
    });
    const step = store.create<Step>(owner.id, {
      runId: run.id,
      type: 'image',
      index: 0,
      state: 'done',
      requestId: randomUUID(),
      resultId: result.id,
    });
    step.id = `${run.id}:image:0`;
    await store.insert('step', step);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });
  it('lists individual runs and limits shared assets to their run', async () => {
    const list = await request(http())
      .get('/api/agent/workspace/jobs')
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    expect(
      (list.body as { items: { id: string }[] }).items.map((j) => j.id),
    ).toContain(run.id);
    await request(http())
      .get(`/api/agent/workspace/jobs/${run.id}`)
      .auth(outsiderToken, { type: 'bearer' })
      .expect(403);
    await request(http())
      .get(`/api/agent/workspace/jobs/${run.id}/assets/${result.id}`)
      .auth(viewerToken, { type: 'bearer' })
      .expect(200);
    const unrelated = await app
      .get(AgentAssetsService)
      .save(
        owner.id,
        (await app.get(AgentAssetsService).read(owner.id, source.id)).buffer,
        { name: 'private.png', kind: 'source', category: 'POD' },
      );
    await request(http())
      .get(`/api/agent/workspace/jobs/${run.id}/assets/${unrelated.id}`)
      .auth(viewerToken, { type: 'bearer' })
      .expect(403);
    const privateRun = { ...run, id: randomUUID(), projectId: undefined };
    await store.insert('run', privateRun);
    const outsiderList = await request(http())
      .get('/api/agent/workspace/jobs')
      .auth(outsiderToken, { type: 'bearer' })
      .expect(200);
    expect((outsiderList.body as { items: unknown[] }).items).toHaveLength(0);
    await request(http())
      .get('/api/agent/workspace/projects')
      .auth(ownerToken, { type: 'bearer' })
      .expect(200);
  });
  it('enforces per-action review permissions and stores the review conversation', async () => {
    const path = `/api/agent/workspace/jobs/${run.id}/comments`,
      body = {
        text: 'Checked design and scene',
        action: 'approved',
        assetId: result.id,
      };
    await request(http())
      .post(path)
      .auth(viewerToken, { type: 'bearer' })
      .send(body)
      .expect(403);
    await request(http())
      .post(path)
      .auth(reviewerToken, { type: 'bearer' })
      .send(body)
      .expect(201);
    expect((await store.get<Asset>('asset', result.id, owner.id)).review).toBe(
      'approved',
    );
    expect((await store.get<Run>('run', run.id, owner.id)).state).toBe(
      'completed',
    );
    expect(
      (await store.query('notification', { owner: owner.id })).length,
    ).toBeGreaterThan(0);
  });
  it('retrieves only related, permitted knowledge and supports Vietnamese full-text search', async () => {
    const create = (
      ownerId: string,
      title: string,
      visibility: Knowledge['visibility'],
      project?: string,
    ) =>
      store.insert(
        'knowledge',
        store.create<Knowledge>(ownerId, {
          title,
          content: 'Giữ nguyên hình in Pokémon ornament. Màu cam thương hiệu.',
          tags: ['ornament'],
          visibility,
          projectId: project,
          revision: 1,
          archived: false,
        }),
      );
    const own = await create(viewer.id, 'Mine', 'private'),
      shared = await create(owner.id, 'Brand', 'company'),
      team = await create(owner.id, 'Team', 'project', projectId),
      secret = await create(outsider.id, 'Private', 'private');
    const selected = await retrieveKnowledge(
        store,
        viewer.id,
        'ornament',
        projectId,
      ),
      ids = selected.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining([own.id, shared.id, team.id]));
    expect(ids).not.toContain(secret.id);
    const outsiderSelected = await retrieveKnowledge(
      store,
      outsider.id,
      'ornament',
      projectId,
    );
    expect(outsiderSelected.map((k) => k.id)).not.toContain(team.id);
    const response = await request(http())
      .post('/api/agent/workspace/knowledge')
      .auth(viewerToken, { type: 'bearer' })
      .send({ title: 'Forbidden', content: 'Test', visibility: 'company' })
      .expect(403);
    expect(response.body).toBeDefined();
  });
  it('splits exact CSV pairs into idempotent lots without cross-products or paid retries', async () => {
    const csv = `sku,sourceId,targetId,prompt\nA,${source.id},${target.id},Replace ornament\nB,${source.id},${target.id},Keep original design`;
    const mapping = {
      sku: 'sku',
      sourceId: 'sourceId',
      targetId: 'targetId',
      prompt: 'prompt',
    };
    const batch = await production.createBatch(owner, {
      name: 'Batch',
      csv,
      mapping,
      provider: 'shopaikey',
    });
    const [first, second] = await Promise.all([
      production.submit(owner.id, batch.id, randomUUID()),
      production.submit(owner.id, batch.id, randomUUID()),
    ]);
    void first;
    void second;
    const runs = await store.query<Run>('run', {
      owner: owner.id,
      conversationId: batch.conversationId,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].items).toHaveLength(2);
    expect(runs[0].count).toBe(2);
    expect(runs[0].items.map((i) => i.sku)).toEqual(['A', 'B']);
    const followup = await app.get(AgentService).message(
      owner.id,
      batch.conversationId,
      {
        id: randomUUID(),
        parentRunId: runs[0].id,
        text: 'Keep both products and use PNG.',
        operation: 'mockup_ai',
        sourceIds: runs[0].sourceIds,
        targetIds: runs[0].targetIds,
        templateIds: [],
        count: 2,
        productType: 'POD',
        provider: 'shopaikey',
        research: '',
        researchSources: [],
        validateVisually: false,
      },
      randomUUID(),
    );
    expect(followup.items.map((item) => [item.sku, item.rowPrompt])).toEqual([
      ['A', 'Replace ornament'],
      ['B', 'Keep original design'],
    ]);
    await production.submit(owner.id, batch.id, randomUUID());
    expect(
      (
        await store.query<Run>('run', { conversationId: batch.conversationId })
      ).filter((r) => r.id === runs[0].id),
    ).toHaveLength(1);
    await expect(
      production.preview(outsider.id, csv, mapping),
    ).rejects.toThrow();
  });
  it('accepts a 500-row CSV above the default HTTP body size and refuses a 501st row', async () => {
    const mapping = {
      sku: 'sku',
      sourceId: 'sourceId',
      targetId: 'targetId',
      prompt: 'prompt',
    };
    const rows = Array.from(
      { length: 500 },
      (_, i) =>
        `SKU-${i},${source.id},${target.id},${'Giữ nguyên thiết kế. '.repeat(12)}`,
    );
    const csv = 'sku,sourceId,targetId,prompt\n' + rows.join('\n');
    expect(Buffer.byteLength(csv)).toBeGreaterThan(100000);
    const response = await request(http())
      .post('/api/agent/production/batches/preview')
      .auth(ownerToken, { type: 'bearer' })
      .send({ csv, mapping })
      .expect(201);
    expect((response.body as unknown[]).length).toBe(500);
    await request(http())
      .post('/api/agent/production/batches/preview')
      .auth(ownerToken, { type: 'bearer' })
      .send({
        csv: csv + `\nSKU-500,${source.id},${target.id},Keep image`,
        mapping,
      })
      .expect(400);
  });
  it('keeps the company credit unit in job costs and evaluation snapshots', async () => {
    await store.ensure('budget-policy', {
      ...store.create('', {
        currency: 'CREDIT',
        defaultWeeklyUsd: 50,
        prices: [],
      }),
      id: 'company',
    });
    const detail = await request(http())
      .get(`/api/agent/workspace/jobs/${run.id}`)
      .auth(ownerToken, { type: 'bearer' })
      .expect(200);
    expect((detail.body as { cost: { currency: string } }).cost.currency).toBe(
      'CREDIT',
    );
    const test = await request(http())
      .post('/api/agent/production/evaluations')
      .auth(ownerToken, { type: 'bearer' })
      .send({
        name: 'Credit accounting',
        sourceId: run.sourceIds[0],
        requirements: 'Preserve the product',
        expectedCount: 1,
      })
      .expect(201);
    const evaluation = await request(http())
      .post(
        `/api/agent/production/evaluations/${(test.body as { id: string }).id}/results`,
      )
      .auth(ownerToken, { type: 'bearer' })
      .send({
        runId: run.id,
        score: 90,
        notes: 'Verified provider credit unit',
      })
      .expect(201);
    expect((evaluation.body as { currency: string }).currency).toBe('CREDIT');
  });
  it('exports the requested pixel size and rejects a fake transparent output', async () => {
    const preset = {
      name: 'Test',
      width: 128,
      height: 96,
      dpi: 300,
      safeMargin: 8,
      transparent: false,
      approvedOnly: true,
    };
    const output = await production.exportImage(
      owner.id,
      result.id,
      preset,
      'SKU-001',
    );
    const info = await sharp(output.buffer).metadata();
    expect([info.width, info.height, info.density]).toEqual([128, 96, 300]);
    const pod = await request(http())
      .post('/api/agent/production/exports')
      .auth(ownerToken, { type: 'bearer' })
      .send({
        assetId: result.id,
        sku: 'SKU-POD',
        preset: {
          ...preset,
          name: 'POD-4500x5400',
          width: 4500,
          height: 5400,
          safeMargin: 0,
        },
      })
      .expect(201);
    expect(
      (pod.body as { asset: { width: number; height: number } }).asset,
    ).toMatchObject({ width: 4500, height: 5400 });
    const longName = await production.exportImage(
      owner.id,
      result.id,
      { ...preset, name: 'a'.repeat(60) },
      'A'.repeat(80),
    );
    expect(longName.filename.length).toBeLessThanOrEqual(120);
    expect(longName.filename.endsWith('.png')).toBe(true);
    await expect(
      production.exportImage(
        owner.id,
        result.id,
        { ...preset, transparent: true },
        'SKU-001',
      ),
    ).rejects.toThrow();
    await expect(
      production.exportImage(owner.id, source.id, preset, 'SKU-001'),
    ).rejects.toThrow();
  });
});
