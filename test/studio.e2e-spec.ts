import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import JSZip from 'jszip';
import { AgentStore } from '../src/agent/agent.store';
import {
  AgentAuthService,
  AgentGuard,
  AgentAdminGuard,
} from '../src/agent/agent-auth.service';
import { AgentAssetsService } from '../src/agent/agent-assets.service';
import { AgentController } from '../src/agent/agent.controller';
import { AgentService } from '../src/agent/agent.service';
import { R2Service } from '../src/r2/r2.service';
import { AIService } from '../src/ai/ai.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { TaskQueueService } from '../src/queue/task-queue.service';
import { StudioController, StudioGuard } from '../src/studio/studio.controller';
import { StudioService } from '../src/studio/studio.service';
import { StudioLibraryService } from '../src/studio/studio-library.service';
import { StudioBundleService } from '../src/studio/studio-bundle.service';
import { StudioWorker } from '../src/studio/studio.worker';
import { StudioMockupService } from '../src/studio/studio-mockup.service';
import { StudioMockupWorker } from '../src/studio/studio-mockup.worker';
import { StudioMockupController } from '../src/studio/studio-mockup.controller';
import type {
  MockupInput,
  StudioMockup,
  StudioMockupSlot,
} from '../src/studio/studio-mockup.types';
import { StudioOperationsService } from '../src/studio/studio-operations.service';
import { StudioOperationsController } from '../src/studio/studio-operations.controller';
import { BudgetService } from '../src/agent/budget.service';
import { ApiError } from '../src/common/api-error';
import type { AgentUser, Asset } from '../src/agent/agent.types';
import type {
  IdeaInput,
  StudioIdea,
  StudioResource,
  StudioSlot,
  StudioStore,
  StudioTeam,
  StudioTicket,
  StudioPlanStep,
} from '../src/studio/studio.types';

describe('Creative Studio (isolated MongoDB; no paid calls)', () => {
  let mongo: MongoMemoryServer,
    app: INestApplication,
    service: StudioService,
    worker: StudioWorker,
    store: AgentStore;
  let admin: AgentUser,
    leader: AgentUser,
    seller: AgentUser,
    outsider: AgentUser;
  const tokens = new Map<string, string>();
  const blobs = new Map<string, Buffer>();
  const queue = {
    enabled: false,
    register: jest.fn(),
    reserve: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    touch: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(undefined),
  };
  const ai = {
    validateImageModel: jest.fn().mockResolvedValue(undefined),
    composeImage: jest.fn<Promise<Buffer>, unknown[]>(),
    analyzeStudioImages: jest.fn().mockResolvedValue({
      summary: 'Thiết kế thú cưng trên sản phẩm tham khảo.',
      invariants: ['Chủ đề thú cưng'],
      editable: ['Bố cục'],
      sourceArtifacts: ['Dây treo'],
      risks: ['Cần kiểm tra chữ'],
    }),
    agentJSON: jest.fn().mockImplementation((prompt: string) => {
      const count = Number(/tổng (\d+) mẫu/.exec(prompt)?.[1] ?? 1);
      return Promise.resolve({
        briefs: Array.from({ length: count }, (_, index) => ({
          title: `Concept ${index + 1}`,
          direction: `Hướng sáng tạo ${index + 1}`,
          composition: `Bố cục có khung ${index + 1}`,
          palette: 'Cam kem',
          prompt: `Thiết kế riêng biệt số ${index + 1}, ảnh nguồn là ý tưởng và ảnh master là mẫu hình học.`,
        })),
      });
    }),
  };
  let team: StudioTeam,
    shop: StudioStore,
    source: Asset,
    master: Asset,
    product: StudioResource,
    skill: StudioResource,
    thumbnail: StudioResource,
    input: IdeaInput;
  let config: ConfigService;
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const auth = (user: AgentUser) => `Bearer ${tokens.get(user.id)}`;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    config = new ConfigService({
      AGENT_ENABLED: true,
      STUDIO_ENABLED: true,
      STUDIO_SCHEDULER_ENABLED: true,
      QUEUE_ENABLED: false,
      MONGODB_URI: mongo.getUri(),
      AGENT_ASSET_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    });
    const module = await Test.createTestingModule({
      controllers: [
        StudioController,
        AgentController,
        StudioOperationsController,
        StudioMockupController,
      ],
      providers: [
        AgentStore,
        AgentAuthService,
        AgentGuard,
        AgentAdminGuard,
        AgentAssetsService,
        StudioService,
        StudioLibraryService,
        StudioBundleService,
        StudioWorker,
        StudioMockupService,
        StudioMockupWorker,
        StudioGuard,
        StudioOperationsService,
        {
          provide: BudgetService,
          useValue: {
            repairTeamBudget: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ConfigService, useValue: config },
        { provide: AIService, useValue: ai },
        { provide: AgentService, useValue: {} },
        { provide: TaskQueueService, useValue: queue },
        {
          provide: AuditLogService,
          useValue: {
            run: (_context: unknown, fn: () => unknown) => fn(),
            write: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: R2Service,
          useValue: {
            putAgentObject: (_owner: string, id: string, buffer: Buffer) => {
              blobs.set(id, buffer);
              return Promise.resolve(id);
            },
            getAgentObject: (id: string) => Promise.resolve(blobs.get(id)),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    store = app.get(AgentStore);
    service = app.get(StudioService);
    worker = app.get(StudioWorker);
    const identities = app.get(AgentAuthService);
    const accounts: AgentUser[] = [];
    for (const [name, role] of [
      ['admin', 'admin'],
      ['leader', 'designer'],
      ['seller', 'designer'],
      ['outsider', 'designer'],
    ] as const) {
      const account = await identities.createUser(
        `${name}@example.test`,
        'studio-test-password',
        role,
      );
      accounts.push(await store.find<AgentUser>('user', account.id));
      tokens.set(
        account.id,
        (
          await identities.login(
            account.email,
            'studio-test-password',
            randomUUID(),
          )
        ).token,
      );
    }
    [admin, leader, seller, outsider] = accounts;
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#ee8a30' },
    })
      .png()
      .toBuffer();
    ai.composeImage.mockResolvedValue(png);
    source = await service.assets.save(seller.id, png, {
      name: 'idea.png',
      kind: 'source',
      category: 'POD',
    });
    const masterPng = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#20509a' },
    })
      .png()
      .toBuffer();
    master = await service.assets.save(admin.id, masterPng, {
      name: 'master.png',
      kind: 'template',
      category: 'POD',
    });
    team = await service.saveTeam(admin, undefined, {
      name: 'Creative',
      archived: false,
      members: [
        { userId: leader.id, role: 'leader' },
        { userId: seller.id, role: 'seller' },
      ],
    });
    product = await service.saveResource(admin, {
      teamId: team.id,
      type: 'product',
      name: 'Doormat',
      code: 'P01',
      instructions: 'Flat low-pile velvet; stitched edge.',
    });
    skill = await service.saveResource(admin, {
      teamId: team.id,
      type: 'skill',
      name: 'Creative',
      code: 'SK02',
      instructions: 'Redesign standalone images. Keep geometry, vary scene.',
    });
    skill = await service.approveResource(
      admin,
      skill.id,
      skill.revision,
      'approved',
    );
    thumbnail = await service.saveResource(admin, {
      teamId: team.id,
      type: 'thumbnail',
      name: 'M01',
      code: 'M01',
      instructions: 'Mat geometry benchmark; scene variation.',
      assetId: master.id,
    });
    shop = await service.saveStore(admin, undefined, {
      teamId: team.id,
      name: 'POD Store',
      sellerIds: [seller.id],
      productIds: [product.id],
      archived: false,
    });
    input = {
      title: 'Christmas mat',
      storeId: shop.id,
      productId: product.id,
      skillId: skill.id,
      thumbnailId: thumbnail.id,
      sourceId: source.id,
      sourceUrl: '',
      brief:
        'Redesign ảnh này thành 7 mẫu riêng biệt cho P01, dùng SK02 và mockup M01',
      count: 7,
      timing: 'now',
      provider: 'shopaikey',
      imageModel: 'test-image',
    };
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });
  async function approved(override: Partial<IdeaInput> = {}) {
    const actor = override.timing === 'night' ? admin : seller;
    const adminSource =
      override.timing === 'night'
        ? await service.assets.save(
            admin.id,
            await sharp({
              create: {
                width: 64,
                height: 64,
                channels: 3,
                background: '#ee8a30',
              },
            })
              .png()
              .toBuffer(),
            { name: 'admin-idea.png', kind: 'source', category: 'POD' },
          )
        : undefined;
    const idea = await service.saveIdea(actor, undefined, {
      ...input,
      ...override,
      ...(adminSource ? { sourceId: adminSource.id } : {}),
    });
    const pending = await service.submit(actor, idea.id, idea.revision);
    return service.decide(
      actor === admin ? admin : leader,
      idea.id,
      pending.revision,
      'approved',
      '',
    );
  }
  async function preparePlan(ticketId: string) {
    const ticket = await store.find<StudioTicket>('studio-ticket', ticketId);
    await worker.tick();
    await worker.executePlan(`${ticketId}-analysis`, ticket.owner);
    await worker.tick();
    await worker.executePlan(`${ticketId}-briefs`, ticket.owner);
    await worker.tick();
  }
  it('requires authentication and hides stores/resources across teams', async () => {
    await request(http()).get('/api/agent/studio/bootstrap').expect(401);
    const hidden = await request(http())
      .get('/api/agent/studio/bootstrap')
      .set('Authorization', auth(outsider))
      .expect(200);
    const hiddenBody = hidden.body as {
      stores: unknown[];
      resources: unknown[];
    };
    expect(hiddenBody.stores).toEqual([]);
    expect(hiddenBody.resources).toEqual([]);
    await request(http())
      .post('/api/agent/studio/teams')
      .set('Authorization', auth(seller))
      .send({ name: 'bad', members: [], archived: false })
      .expect(403);
    await request(http())
      .get(`/api/agent/studio/assets/${master.id}`)
      .set('Authorization', auth(outsider))
      .expect(404);
    const shared = await request(http())
      .get(`/api/agent/studio/assets/${master.id}`)
      .set('Authorization', auth(seller))
      .expect(200);
    expect(shared.headers['content-type']).toContain('image/png');
    expect((await store.find<Asset>('asset', master.id)).owner).toBe(admin.id);
  });
  it('rejects foreign input assets and stale drafts from a second tab', async () => {
    await request(http())
      .post('/api/agent/studio/ideas')
      .set('Authorization', auth(outsider))
      .send(input)
      .expect(404);
    await request(http())
      .post('/api/agent/studio/ideas')
      .set('Authorization', auth(seller))
      .send({ ...input, sourceId: master.id })
      .expect(404);
    const idea = await service.saveIdea(seller, undefined, input);
    const results = await Promise.allSettled([
      service.saveIdea(
        seller,
        idea.id,
        { ...input, title: 'Tab A' },
        idea.revision,
      ),
      service.saveIdea(
        seller,
        idea.id,
        { ...input, title: 'Tab B' },
        idea.revision,
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });
  it('saves incomplete drafts but blocks submission until inputs are complete', async () => {
    const draft = await service.saveIdea(seller, undefined, {
      ...input,
      productId: '',
      skillId: '',
      thumbnailId: '',
      sourceId: '',
      brief: '',
      imageModel: '',
    });
    expect(draft.state).toBe('draft');
    await request(http())
      .post(`/api/agent/studio/ideas/${draft.id}/submit`)
      .set('Authorization', auth(seller))
      .send({ revision: draft.revision })
      .expect(400);
    const saved = await service.saveIdea(
      seller,
      draft.id,
      input,
      draft.revision,
    );
    expect((await service.submit(seller, saved.id, saved.revision)).state).toBe(
      'pending',
    );
  });
  it('only Leader approves; concurrent clicks produce one immutable ticket', async () => {
    const idea = await service.saveIdea(seller, undefined, input);
    const pending = await service.submit(seller, idea.id, 1);
    await request(http())
      .post(`/api/agent/studio/ideas/${idea.id}/review`)
      .set('Authorization', auth(seller))
      .send({ revision: pending.revision, decision: 'approved', note: '' })
      .expect(404);
    const results = await Promise.allSettled([
      service.decide(leader, idea.id, pending.revision, 'approved', ''),
      service.decide(leader, idea.id, pending.revision, 'approved', ''),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const tickets = await store.query<StudioTicket>('studio-ticket', {
      ideaId: idea.id,
    });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].snapshot.source.id).toBe(source.id);
    expect(tickets[0].snapshot.master.id).toBe(master.id);
    const edited = await service.saveIdea(
      seller,
      idea.id,
      { ...input, brief: 'Changed after approval' },
      pending.revision + 1,
    );
    expect(edited.state).toBe('draft');
    expect(
      (await store.find<StudioTicket>('studio-ticket', tickets[0].id)).snapshot
        .input.brief,
    ).toBe(input.brief);
  });
  it('dispatches seven stable slots; each call has both images and the final prompt; redelivery never calls AI twice', async () => {
    const idea = await approved();
    await preparePlan(idea.ticketId);
    const slots = await store.query<StudioSlot>(
      'studio-slot',
      { ticketId: idea.ticketId },
      100,
    );
    expect(slots).toHaveLength(7);
    const before = ai.composeImage.mock.calls.length;
    await Promise.all(
      slots.flatMap((slot) => [
        worker.execute(slot.id, slot.owner),
        worker.execute(slot.id, slot.owner),
      ]),
    );
    expect(ai.composeImage.mock.calls.length - before).toBe(7);
    const expectedSource = (
      await service.assets.read(seller.id, source.id)
    ).buffer.toString('base64');
    const expectedMaster = (
      await service.assets.read(admin.id, master.id)
    ).buffer.toString('base64');
    expect(expectedSource).not.toBe(expectedMaster);
    for (const call of ai.composeImage.mock.calls.slice(before)) {
      const params = call[0] as {
        images: { base64: string }[];
        prompt: string;
      };
      expect(params.images).toHaveLength(2);
      expect(params.images[0].base64).toBe(expectedSource);
      expect(params.images[1].base64).toBe(expectedMaster);
      expect(params.prompt).toContain(input.brief);
      expect(params.prompt).toContain('ẢNH 1:');
      expect(params.prompt).toContain('ẢNH 2:');
      expect(params.prompt).toContain('watermark');
    }
    await worker.tick();
    await worker.execute(slots[0].id, seller.id);
    expect(ai.composeImage.mock.calls.length - before).toBe(7);
    expect(
      (await store.find<StudioTicket>('studio-ticket', idea.ticketId)).state,
    ).toBe('review');
    const detail = await service.detail(leader, idea.id);
    expect(detail.assets).toHaveLength(7);
    expect(detail.assets[0]).not.toHaveProperty('storageKey');
    await service.reviewOutput(
      leader,
      idea.ticketId,
      detail.assets[0].id,
      'approved',
      'checked',
    );
    expect(
      (await service.outputs(seller)).items.some(
        (item) => item.assetId === detail.assets[0].id,
      ),
    ).toBe(true);
    expect((await service.outputs(outsider)).items).toEqual([]);
  });
  it('does not resubmit an interrupted request or duplicate a nightly selection', async () => {
    const idea = await approved({ count: 1, timing: 'night' });
    const ticket = await store.find<StudioTicket>(
      'studio-ticket',
      idea.ticketId,
    );
    await worker.tick(new Date(Date.parse(ticket.dueAt) - 1000));
    expect(
      (await store.query('studio-slot', { ticketId: ticket.id })).length,
    ).toBe(0);
    await worker.tick(new Date(Date.parse(ticket.dueAt) + 1000));
    await preparePlan(ticket.id);
    const slots = await store.query<StudioSlot>('studio-slot', {
      ticketId: ticket.id,
    });
    expect(slots).toHaveLength(1);
    await store.patch<StudioSlot>('studio-slot', slots[0].id, ticket.owner, {
      state: 'submitted',
      leaseUntil: 0,
    });
    const before = ai.composeImage.mock.calls.length;
    await worker.tick();
    await worker.execute(slots[0].id, ticket.owner);
    await worker.tick(new Date(Date.parse(ticket.dueAt) + 86400000));
    expect(ai.composeImage.mock.calls.length).toBe(before);
    expect(
      (await store.find<StudioSlot>('studio-slot', slots[0].id)).state,
    ).toBe('interrupted');
    expect(
      await store.query('studio-slot', { ticketId: ticket.id }),
    ).toHaveLength(1);
  });
  it('marks a missed nightly window and only admin can catch it up', async () => {
    const idea = await approved({ count: 1, timing: 'night' });
    const ticket = await store.find<StudioTicket>(
      'studio-ticket',
      idea.ticketId,
    );
    await worker.tick(new Date(Date.parse(ticket.dueAt) + 10 * 60000));
    expect(
      (await store.find<StudioTicket>('studio-ticket', ticket.id)).state,
    ).toBe('missed');
    await request(http())
      .post(`/api/agent/studio/tickets/${ticket.id}/catch-up`)
      .set('Authorization', auth(seller))
      .expect(403);
    await request(http())
      .post(`/api/agent/studio/tickets/${ticket.id}/catch-up`)
      .set('Authorization', auth(admin))
      .expect(201);
    expect(
      (await store.find<StudioTicket>('studio-ticket', ticket.id)).state,
    ).toBe('queued');
  });
  it('rechecks account/store access at execution and blocks revoked work', async () => {
    const idea = await approved({ count: 1 });
    await preparePlan(idea.ticketId);
    const slot = (
      await store.query<StudioSlot>('studio-slot', { ticketId: idea.ticketId })
    )[0];
    await service.saveStore(admin, shop.id, {
      ...shop,
      sellerIds: [],
      revision: shop.revision,
    });
    const before = ai.composeImage.mock.calls.length;
    await worker.execute(slot.id, seller.id);
    expect(ai.composeImage.mock.calls.length).toBe(before);
    expect((await store.find<StudioSlot>('studio-slot', slot.id)).state).toBe(
      'failed',
    );
    const generated = (
      await store.query<Asset>(
        'asset',
        { studioTicketId: { $exists: true } },
        1,
      )
    )[0];
    await request(http())
      .get(`/api/agent/studio/assets/${generated.id}`)
      .set('Authorization', auth(seller))
      .expect(404);
    await request(http())
      .get(`/api/agent/assets/${generated.id}/content`)
      .set('Authorization', auth(seller))
      .expect(404);
    await request(http())
      .get(`/api/agent/assets/${generated.id}/preview`)
      .set('Authorization', auth(seller))
      .expect(404);
    await request(http())
      .get(`/api/agent/studio/assets/${generated.id}`)
      .set('Authorization', auth(leader))
      .expect(200);
    shop = (await store.find<StudioStore>('studio-store', shop.id))!;
    shop = await service.saveStore(admin, shop.id, {
      ...shop,
      sellerIds: [seller.id],
      revision: shop.revision,
    });
  });
  it('keeps the feature disabled unless explicitly enabled', async () => {
    const count = (await store.query<StudioIdea>('studio-idea', {})).length;
    config.set('STUDIO_ENABLED', false);
    await expect(
      worker.execute('disabled-slot', seller.id),
    ).resolves.toBeUndefined();
    await expect(
      worker.executePlan('disabled-plan', seller.id),
    ).resolves.toBeUndefined();
    await expect(
      app.get(StudioMockupWorker).execute('disabled-mockup', seller.id),
    ).resolves.toBeUndefined();
    await request(http())
      .get('/api/agent/studio/bootstrap')
      .set('Authorization', auth(seller))
      .expect(503);
    config.set('STUDIO_ENABLED', true);
    expect(await store.query<StudioIdea>('studio-idea', {})).toHaveLength(
      count,
    );
  });
  it('persists encrypted original ZIPs, immutable version history and chosen case images', async () => {
    const zip = new JSZip();
    zip.file(
      'bundle/SKILL.md',
      '---\nversion: 2.2\n---\nRead `references/SPEC.md`. Use `cases/example.png`.',
    );
    zip.file('bundle/references/SPEC.md', 'Flat printed design; no scripts.');
    zip.file(
      'bundle/cases/example.png',
      (await service.assets.read(admin.id, master.id)).buffer,
    );
    const original = await zip.generateAsync({ type: 'nodebuffer' });
    const library = app.get(StudioLibraryService);
    const imported = await library.import(
      admin,
      { teamId: team.id, name: 'Bundled skill', code: 'SKZIP' },
      original,
    );
    const resource = imported.resource;
    expect(resource.importState).toBe('ready');
    expect(resource.status).toBe('pending');
    expect(resource.versionNumber).toBe(1);
    expect(resource.contextImages).toHaveLength(1);
    const bundles = await store.query<{ gridId: string }>('studio-bundle', {
      id: resource.bundleId,
    });
    expect(
      (await store.readImageBackup(bundles[0].gridId)).equals(original),
    ).toBe(false);
    expect(
      (await library.download(admin, resource.id)).buffer.equals(original),
    ).toBe(true);
    await request(http())
      .get(`/api/agent/studio/skills/${resource.id}/bundle`)
      .set('Authorization', auth(seller))
      .expect(403);
    await request(http())
      .get(`/api/agent/studio/skills/${resource.id}/versions`)
      .set('Authorization', auth(outsider))
      .expect(404);
    const selected = await library.selectContext(
      admin,
      resource.id,
      resource.revision,
      [resource.contextImages[0].path],
    );
    await expect(
      library.selectContext(admin, resource.id, resource.revision, []),
    ).rejects.toThrow();
    const approvedSkill = await service.approveResource(
      admin,
      resource.id,
      selected.revision,
      'approved',
    );
    await expect(
      library.selectContext(admin, resource.id, approvedSkill.revision, []),
    ).rejects.toThrow();
    const nextZip = new JSZip();
    nextZip.file('SKILL.md', 'version: 2.3\nNew creative rules.');
    const nextBytes = await nextZip.generateAsync({ type: 'nodebuffer' });
    const newVersion = await library.import(
      admin,
      {
        teamId: team.id,
        name: 'Bundled skill',
        code: 'SKZIP',
        previousId: resource.id,
      },
      nextBytes,
    );
    expect(newVersion.resource.versionNumber).toBe(2);
    expect(newVersion.resource.status).toBe('pending');
    await expect(
      library.import(
        admin,
        {
          teamId: team.id,
          name: 'Concurrent upload',
          code: 'SKZIP',
          previousId: resource.id,
        },
        nextBytes,
      ),
    ).rejects.toThrow();
    const versions = await library.versions(admin, resource.id);
    expect(versions).toHaveLength(2);
    expect(
      (await library.download(admin, resource.id)).buffer.equals(original),
    ).toBe(true);
    const idea = await approved({ skillId: resource.id, count: 1 });
    const snapshot = (
      await store.find<StudioTicket>('studio-ticket', idea.ticketId)
    ).snapshot;
    expect(snapshot.contextImages).toHaveLength(1);
    expect(snapshot.skill.versionNumber).toBe(1);
    await preparePlan(idea.ticketId);
    const slot = (
      await store.query<StudioSlot>('studio-slot', { ticketId: idea.ticketId })
    )[0];
    const imageCalls = ai.composeImage.mock.calls.length;
    await worker.execute(slot.id, seller.id);
    expect(
      (ai.composeImage.mock.calls[imageCalls][0] as { images: unknown[] })
        .images,
    ).toHaveLength(3);
    expect(snapshot.skill.bundleHash).toBe(resource.bundleHash);
  });
  it('blocks incomplete/broken skill imports from approval', async () => {
    const zip = new JSZip();
    zip.file('SKILL.md', 'Read `references/NOT_FOUND.md`.');
    const imported = await app
      .get(StudioLibraryService)
      .import(
        admin,
        { teamId: team.id, name: 'Missing file', code: 'SKMISSING' },
        await zip.generateAsync({ type: 'nodebuffer' }),
      );
    expect(imported.resource.issues.join()).toContain('NOT_FOUND');
    await expect(
      service.approveResource(
        admin,
        imported.resource.id,
        imported.resource.revision,
        'approved',
      ),
    ).rejects.toThrow();
  });
  it('claims planning once, persists observation before text briefs and never repeats completed paid preparation', async () => {
    const idea = await approved({ count: 3 });
    const beforeVision = ai.analyzeStudioImages.mock.calls.length,
      beforeText = ai.agentJSON.mock.calls.length;
    await worker.tick();
    expect(
      await store.query('studio-slot', { ticketId: idea.ticketId }),
    ).toHaveLength(0);
    await Promise.all([
      worker.executePlan(`${idea.ticketId}-analysis`, seller.id),
      worker.executePlan(`${idea.ticketId}-analysis`, seller.id),
    ]);
    expect(ai.analyzeStudioImages.mock.calls.length - beforeVision).toBe(1);
    const analysis = await store.find<StudioPlanStep>(
      'studio-plan',
      `${idea.ticketId}-analysis`,
    );
    expect(analysis.analysis.invariants).toContain('Chủ đề thú cưng');
    await worker.tick();
    expect(
      await store.query('studio-slot', { ticketId: idea.ticketId }),
    ).toHaveLength(0);
    await worker.executePlan(`${idea.ticketId}-briefs`, seller.id);
    await worker.tick();
    expect(ai.agentJSON.mock.calls.length - beforeText).toBe(1);
    const lastBriefCall = ai.agentJSON.mock.calls.at(-1) as [string];
    expect(lastBriefCall[0]).toContain('Chủ đề thú cưng');
    const slots = await store.query<StudioSlot>('studio-slot', {
      ticketId: idea.ticketId,
    });
    expect(slots).toHaveLength(3);
    expect(new Set(slots.map((slot) => slot.prompt)).size).toBe(3);
    expect(slots[0].prompt).toContain('Hướng sáng tạo');
    await worker.executePlan(analysis.id, seller.id);
    await worker.executePlan(`${idea.ticketId}-briefs`, seller.id);
    expect(ai.analyzeStudioImages.mock.calls.length - beforeVision).toBe(1);
    expect(ai.agentJSON.mock.calls.length - beforeText).toBe(1);
  });
  it('retains uncertain analysis calls for reconciliation and never falls through to generic image prompts', async () => {
    const idea = await approved({ count: 1 });
    await worker.tick();
    ai.analyzeStudioImages.mockRejectedValueOnce(
      new Error('network outcome unknown'),
    );
    const count = ai.analyzeStudioImages.mock.calls.length;
    await worker.executePlan(`${idea.ticketId}-analysis`, seller.id);
    await worker.tick();
    expect(
      (
        await store.find<StudioPlanStep>(
          'studio-plan',
          `${idea.ticketId}-analysis`,
        )
      ).state,
    ).toBe('interrupted');
    expect(
      (await store.find<StudioTicket>('studio-ticket', idea.ticketId)).state,
    ).toBe('blocked');
    await worker.executePlan(`${idea.ticketId}-analysis`, seller.id);
    expect(ai.analyzeStudioImages.mock.calls.length - count).toBe(1);
    expect(
      await store.query('studio-slot', { ticketId: idea.ticketId }),
    ).toHaveLength(0);
  });
  it('rejects malformed briefs and cancellation between preparation phases without generating images', async () => {
    const idea = await approved({ count: 2 });
    await worker.tick();
    await worker.executePlan(`${idea.ticketId}-analysis`, seller.id);
    await worker.tick();
    ai.agentJSON.mockResolvedValueOnce({ briefs: [] });
    await worker.executePlan(`${idea.ticketId}-briefs`, seller.id);
    await worker.tick();
    expect(
      (
        await store.find<StudioPlanStep>(
          'studio-plan',
          `${idea.ticketId}-briefs`,
        )
      ).state,
    ).toBe('failed');
    expect(
      await store.query('studio-slot', { ticketId: idea.ticketId }),
    ).toHaveLength(0);
    const cancelled = await approved({ count: 1 });
    await worker.tick();
    await service.cancel(seller, cancelled.ticketId);
    const count = ai.analyzeStudioImages.mock.calls.length;
    await worker.executePlan(`${cancelled.ticketId}-analysis`, seller.id);
    expect(ai.analyzeStudioImages.mock.calls.length).toBe(count);
  });
  it('creates daytime samples then continues missing slots once without repeating planning or finished images', async () => {
    const idea = await approved({ count: 4, sampleCount: 1 });
    await preparePlan(idea.ticketId);
    const original = (
      await store.query<StudioSlot>('studio-slot', { ticketId: idea.ticketId })
    )[0];
    expect(
      await store.query('studio-slot', { ticketId: idea.ticketId }),
    ).toHaveLength(1);
    await worker.execute(original.id, seller.id);
    await worker.tick();
    expect(
      (await store.find<StudioTicket>('studio-ticket', idea.ticketId)).state,
    ).toBe('sample_review');
    const initialResult = (
      await store.find<StudioSlot>('studio-slot', original.id)
    ).resultId;
    const visionCalls = ai.analyzeStudioImages.mock.calls.length,
      textCalls = ai.agentJSON.mock.calls.length,
      imageCalls = ai.composeImage.mock.calls.length;
    await expect(
      service.continueSamples(outsider, idea.ticketId),
    ).rejects.toThrow();
    const continued = await Promise.allSettled([
      service.continueSamples(seller, idea.ticketId),
      service.continueSamples(seller, idea.ticketId),
    ]);
    expect(
      continued.filter((item) => item.status === 'fulfilled'),
    ).toHaveLength(1);
    await worker.tick();
    const slots = await store.query<StudioSlot>('studio-slot', {
      ticketId: idea.ticketId,
    });
    expect(slots).toHaveLength(4);
    await Promise.all(slots.map((slot) => worker.execute(slot.id, seller.id)));
    await worker.tick();
    expect(ai.composeImage.mock.calls.length - imageCalls).toBe(3);
    expect(ai.analyzeStudioImages.mock.calls.length).toBe(visionCalls);
    expect(ai.agentJSON.mock.calls.length).toBe(textCalls);
    expect(
      (await store.find<StudioSlot>('studio-slot', original.id)).resultId,
    ).toBe(initialResult);
    expect(
      (await store.find<StudioTicket>('studio-ticket', idea.ticketId)).state,
    ).toBe('review');
    const night = await approved({ count: 3, sampleCount: 1, timing: 'night' });
    expect(
      (await store.find<StudioTicket>('studio-ticket', night.ticketId))
        .dispatchCount,
    ).toBe(3);
    await expect(
      service.saveIdea(seller, undefined, {
        ...input,
        count: 1,
        sampleCount: 2,
      }),
    ).rejects.toThrow();
  });
  it('prevents a stale pre-submission worker from submitting after another worker reclaimed the slot', async () => {
    const idea = await approved({ count: 1 });
    await preparePlan(idea.ticketId);
    const slot = (
      await store.query<StudioSlot>('studio-slot', { ticketId: idea.ticketId })
    )[0];
    const read = service.assets.read.bind(
      service.assets,
    ) as AgentAssetsService['read'];
    let resume!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const spy = jest
      .spyOn(service.assets, 'read')
      .mockImplementationOnce(async (...args) => {
        reached();
        await gate;
        return read(...args);
      });
    const count = ai.composeImage.mock.calls.length;
    const stale = worker.execute(slot.id, seller.id);
    try {
      await waiting;
      await store.patch<StudioSlot>('studio-slot', slot.id, seller.id, {
        leaseUntil: 0,
      });
      await worker.tick();
      await worker.execute(slot.id, seller.id);
      resume();
      await stale;
      expect(ai.composeImage.mock.calls.length - count).toBe(1);
      expect((await store.find<StudioSlot>('studio-slot', slot.id)).state).toBe(
        'done',
      );
    } finally {
      resume();
      spy.mockRestore();
    }
  });
  it('does not expose earlier store snapshots when an idea moves to another permitted store', async () => {
    const idea = await approved({
      count: 1,
      brief: 'Private original Store A requirement',
    });
    const currentTeam = await store.find<StudioTeam>('studio-team', team.id);
    await service.saveTeam(admin, team.id, {
      ...currentTeam,
      members: [
        ...currentTeam.members,
        { userId: outsider.id, role: 'seller' },
      ],
      revision: currentTeam.revision,
    });
    const second = await service.saveStore(admin, undefined, {
      teamId: team.id,
      name: 'Separate Store',
      sellerIds: [seller.id, outsider.id],
      productIds: [product.id],
      archived: false,
    });
    await service.saveIdea(
      seller,
      idea.id,
      {
        ...input,
        storeId: second.id,
        brief: 'Visible new Store B requirement',
      },
      idea.revision,
    );
    const detail = await service.detail(outsider, idea.id);
    expect(detail.idea.input.brief).toBe('Visible new Store B requirement');
    expect(detail.tickets).toEqual([]);
    expect(detail.plans).toEqual([]);
  });
  it('records one nightly occurrence per day and one Team batch, keeping the original cutoff when catching up', async () => {
    const first = await approved({ count: 1, timing: 'night' });
    const second = await approved({ count: 1, timing: 'night' });
    const firstTicket = await store.find<StudioTicket>(
        'studio-ticket',
        first.ticketId,
      ),
      secondTicket = await store.find<StudioTicket>(
        'studio-ticket',
        second.ticketId,
      );
    expect(firstTicket.occurrenceId).toBe(secondTicket.occurrenceId);
    expect(firstTicket.batchId).toBe(secondTicket.batchId);
    await Promise.all([
      service.ensureTicket(first),
      service.ensureTicket(first),
    ]);
    const occurrence = await store.find<{ dueAt: string; cutoffAt: string }>(
      'studio-occurrence',
      firstTicket.occurrenceId,
    );
    expect(occurrence.cutoffAt).toBe(firstTicket.dueAt);
    await worker.tick(new Date(Date.parse(firstTicket.dueAt) + 10 * 60000));
    await request(http())
      .post(`/api/agent/studio/tickets/${firstTicket.id}/catch-up`)
      .set('Authorization', auth(admin))
      .expect(201);
    const catchUp = await store.find<StudioTicket>(
      'studio-ticket',
      firstTicket.id,
    );
    expect(catchUp.dueAt).toBe(firstTicket.dueAt);
    expect(catchUp.catchUpAt).toBeTruthy();
    const batches = await app.get(StudioOperationsService).batches(1);
    expect(
      batches.items.some(
        (batch) => batch.id === firstTicket.batchId && batch.ticketCount >= 2,
      ),
    ).toBe(true);
  });
  it('only admin can resume definitely unsubmitted budget rejections; existing completed slots stay untouched', async () => {
    const idea = await approved({ count: 1 });
    await preparePlan(idea.ticketId);
    const slot = (
      await store.query<StudioSlot>('studio-slot', { ticketId: idea.ticketId })
    )[0];
    ai.composeImage.mockRejectedValueOnce(
      new ApiError(
        403,
        'TEAM_BUDGET_EXCEEDED',
        'Daily cap reached before upstream',
      ),
    );
    await worker.execute(slot.id, seller.id);
    await worker.tick();
    const failed = await store.find<StudioSlot>('studio-slot', slot.id);
    expect(failed.state).toBe('failed');
    expect(failed.errorCode).toBe('TEAM_BUDGET_EXCEEDED');
    await request(http())
      .post(
        `/api/agent/studio/operations/tickets/${idea.ticketId}/resume-budget`,
      )
      .set('Authorization', auth(seller))
      .send({ reason: 'Attempt' })
      .expect(403);
    const resumes = await Promise.all(
      [1, 2].map(() =>
        request(http())
          .post(
            `/api/agent/studio/operations/tickets/${idea.ticketId}/resume-budget`,
          )
          .set('Authorization', auth(admin))
          .send({ reason: 'Daily cap increased' }),
      ),
    );
    expect(resumes.filter((response) => response.status === 201)).toHaveLength(
      1,
    );
    const resumed = await store.find<StudioSlot>('studio-slot', slot.id);
    expect(resumed.requestId).not.toBe(failed.requestId);
    const calls = ai.composeImage.mock.calls.length;
    await worker.execute(slot.id, seller.id);
    await worker.tick();
    expect(ai.composeImage.mock.calls.length - calls).toBe(1);
    expect((await store.find<StudioSlot>('studio-slot', slot.id)).state).toBe(
      'done',
    );
    await request(http())
      .post(
        `/api/agent/studio/operations/tickets/${idea.ticketId}/resume-budget`,
      )
      .set('Authorization', auth(admin))
      .send({ reason: 'Must not repeat' })
      .expect(409);
    const uncertain = await approved({ count: 1 });
    await worker.tick();
    await store.patch<StudioPlanStep>(
      'studio-plan',
      `${uncertain.ticketId}-analysis`,
      seller.id,
      { state: 'interrupted', errorCode: 'BUDGET_REQUEST_UNRESOLVED' },
    );
    await store.patch<StudioTicket>(
      'studio-ticket',
      uncertain.ticketId,
      seller.id,
      { state: 'blocked' },
    );
    await request(http())
      .post(
        `/api/agent/studio/operations/tickets/${uncertain.ticketId}/resume-budget`,
      )
      .set('Authorization', auth(admin))
      .send({ reason: 'Do not retry unknown' })
      .expect(409);
  });
  async function mockupInput(
    overrides: Partial<MockupInput> = {},
  ): Promise<MockupInput> {
    const scene = await service.saveResource(admin, {
      teamId: team.id,
      name: 'Living room',
      type: 'scene',
      code: 'SC01',
      instructions: 'Giữ bố cục và ánh sáng',
      assetId: master.id,
    });
    await service.approveResource(admin, scene.id, 1, 'approved');
    return {
      requestKey: randomUUID(),
      title: 'Team mockup',
      storeId: shop.id,
      productId: product.id,
      sources: [
        { assetId: source.id, sceneIds: [scene.id], colors: ['trắng', 'đen'] },
      ],
      provider: 'shopaikey',
      imageModel: 'test-image',
      instructions: 'Giữ tên trên thiết kế',
      ...overrides,
    };
  }
  it('persists per-source scene/color combinations, rejects spoofing and deduplicates submission/dispatch', async () => {
    const mockups = app.get(StudioMockupService),
      render = app.get(StudioMockupWorker);
    const payload = await mockupInput();
    const created = await request(http())
      .post('/api/agent/studio/mockups')
      .set('Authorization', auth(seller))
      .send(payload)
      .expect(201);
    const job = created.body as StudioMockup;
    expect(job.count).toBe(2);
    const repeated = await mockups.create(seller, payload);
    expect(repeated.id).toBe(job.id);
    await request(http())
      .post('/api/agent/studio/mockups')
      .set('Authorization', auth(seller))
      .send({ ...payload, title: 'Changed' })
      .expect(409);
    await request(http())
      .get(`/api/agent/studio/mockups/${job.id}`)
      .set('Authorization', auth(outsider))
      .expect(404);
    await request(http())
      .post('/api/agent/studio/mockups')
      .set('Authorization', auth(seller))
      .send({
        ...payload,
        requestKey: randomUUID(),
        sources: [{ ...payload.sources[0], assetId: master.id }],
      })
      .expect(404);
    await render.tick();
    await render.tick();
    const detail = await mockups.detail(leader, job.id);
    expect(detail.slots).toHaveLength(2);
    expect(detail.slots.map((s) => s.color)).toEqual(['trắng', 'đen']);
    expect(detail.slots[0].prompt).toContain(
      'ẢNH 1 là sản phẩm/thiết kế NGUỒN',
    );
    expect(detail.slots[0].prompt).toContain('Không tạo watermark');
    const calls = ai.composeImage.mock.calls.length;
    await Promise.all([
      render.execute(detail.slots[0].id, seller.id),
      render.execute(detail.slots[0].id, seller.id),
    ]);
    expect(ai.composeImage.mock.calls.length - calls).toBe(1);
    expect(ai.composeImage.mock.calls[calls]).toEqual([
      {
        prompt: detail.slots[0].prompt,
        images: [
          {
            base64: (
              await service.assets.read(source.owner, source.id)
            ).buffer.toString('base64'),
            mimeType: source.mimeType,
          },
          {
            base64: (
              await service.assets.read(master.owner, master.id)
            ).buffer.toString('base64'),
            mimeType: master.mimeType,
          },
        ],
        imageModel: 'test-image',
      },
      'shopaikey',
    ]);
    await render.execute(detail.slots[1].id, seller.id);
    await render.tick();
    const finished = await mockups.detail(leader, job.id);
    expect(finished.job.state).toBe('review');
    const output = finished.slots[0].resultId;
    await request(http())
      .post(`/api/agent/studio/mockups/${job.id}/review`)
      .set('Authorization', auth(leader))
      .send({ assetId: output, decision: 'approved' })
      .expect(201);
    const outputs = await service.outputs(leader);
    expect(outputs.items.some((r) => r.assetId === output)).toBe(true);
    await request(http())
      .get(`/api/agent/studio/assets/${output}?format=jpg`)
      .set('Authorization', auth(leader))
      .expect(200)
      .expect('Content-Type', /image\/jpeg/);
    await render.execute(detail.slots[0].id, seller.id);
    expect(ai.composeImage.mock.calls.length - calls).toBe(2);
  });
  it('accepts only approved Gallery designs of the same store/product and retains their provenance', async () => {
    const idea = await approved({ count: 1 });
    await preparePlan(idea.ticketId);
    const slot = (
      await store.query<StudioSlot>(
        'studio-slot',
        { ticketId: idea.ticketId },
        1,
      )
    )[0];
    await worker.execute(slot.id, seller.id);
    const done = await store.find<StudioSlot>('studio-slot', slot.id);
    const payload = await mockupInput();
    payload.sources[0].assetId = done.resultId!;
    payload.sources[0].ticketId = idea.ticketId;
    const mockups = app.get(StudioMockupService);
    await expect(mockups.create(seller, payload)).rejects.toThrow();
    await service.reviewOutput(
      leader,
      idea.ticketId,
      done.resultId,
      'approved',
      '',
    );
    const created = await mockups.create(seller, payload);
    expect(created.sources[0].ticketId).toBe(idea.ticketId);
    await service.reviewOutput(
      leader,
      idea.ticketId,
      done.resultId,
      'changes_requested',
      'Wrong motif',
    );
    await expect(mockups.checkPermission(created)).rejects.toThrow();
  });
  it('resumes only known pre-provider failures while retaining completed combinations and blocking uncertain outcomes', async () => {
    const mockups = app.get(StudioMockupService),
      render = app.get(StudioMockupWorker);
    const job = await mockups.create(seller, await mockupInput());
    await mockups.ensureSlots(job);
    const { slots } = await mockups.detail(seller, job.id);
    await render.execute(slots[0].id, seller.id);
    ai.composeImage.mockRejectedValueOnce(
      new ApiError(403, 'TEAM_BUDGET_EXCEEDED', 'Team cap'),
    );
    await render.execute(slots[1].id, seller.id);
    await render.tick();
    const calls = ai.composeImage.mock.calls.length;
    const resumed = await Promise.allSettled([
      mockups.change(seller, job.id, 'continue'),
      mockups.change(seller, job.id, 'continue'),
    ]);
    expect(resumed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await render.execute(slots[0].id, seller.id);
    await render.execute(slots[1].id, seller.id);
    await render.tick();
    expect(ai.composeImage.mock.calls.length - calls).toBe(1);
    expect((await mockups.detail(seller, job.id)).job.state).toBe('review');
    const unknown = await mockups.create(seller, await mockupInput());
    await mockups.ensureSlots(unknown);
    const pending = (await mockups.detail(seller, unknown.id)).slots[0];
    ai.composeImage.mockRejectedValueOnce(new Error('network timeout'));
    await render.execute(pending.id, seller.id);
    await render.tick();
    await expect(
      mockups.change(seller, unknown.id, 'continue'),
    ).rejects.toThrow();
    const before = ai.composeImage.mock.calls.length;
    await render.execute(pending.id, seller.id);
    expect(ai.composeImage.mock.calls.length).toBe(before);
    await mockups.change(seller, unknown.id, 'cancel');
  });
  it('recovers missing slot records but does not retry submitted leases or changed image bytes', async () => {
    const mockups = app.get(StudioMockupService),
      render = app.get(StudioMockupWorker);
    const job = await mockups.create(seller, await mockupInput());
    await render.tick();
    const { slots } = await mockups.detail(seller, job.id);
    await store.patch<StudioMockupSlot>(
      'studio-mockup-slot',
      slots[0].id,
      seller.id,
      { state: 'submitted', leaseUntil: 1, attemptId: 'old' },
    );
    await store.patch<StudioMockup>('studio-mockup', job.id, seller.id, {
      sources: [
        {
          ...job.sources[0],
          image: { ...job.sources[0].image, sha256: 'wrong' },
        },
      ],
    });
    const calls = ai.composeImage.mock.calls.length;
    await render.tick();
    await render.execute(slots[1].id, seller.id);
    const saved = await mockups.detail(seller, job.id);
    expect(saved.slots[0].state).toBe('interrupted');
    expect(saved.slots[1].errorCode).toBe('STUDIO_IMAGE_CHANGED');
    expect(ai.composeImage.mock.calls.length).toBe(calls);
  });
  it('rechecks store revocation on both Studio and legacy mockup image endpoints', async () => {
    const mockups = app.get(StudioMockupService),
      render = app.get(StudioMockupWorker);
    const job = await mockups.create(seller, await mockupInput());
    await mockups.ensureSlots(job);
    const slot = (await mockups.detail(seller, job.id)).slots[0];
    await render.execute(slot.id, seller.id);
    const result = (
      await store.find<StudioMockupSlot>('studio-mockup-slot', slot.id)
    ).resultId;
    await store.patch<StudioStore>('studio-store', shop.id, shop.owner, {
      sellerIds: [],
    });
    try {
      await request(http())
        .get(`/api/agent/studio/assets/${result}`)
        .set('Authorization', auth(seller))
        .expect(404);
      await expect(service.assets.read(seller.id, result)).rejects.toThrow();
      await request(http())
        .get(`/api/agent/studio/mockups/${job.id}`)
        .set('Authorization', auth(seller))
        .expect(404);
    } finally {
      await store.patch<StudioStore>('studio-store', shop.id, shop.owner, {
        sellerIds: [seller.id],
      });
    }
  });
  it('rejects scheduling by sellers and leaders even with a direct API call, while admin can submit scheduled ideas', async () => {
    for (const actor of [seller, leader]) {
      await request(http())
        .post('/api/agent/studio/ideas')
        .set('Authorization', auth(actor))
        .send({ ...input, timing: 'night' })
        .expect(403);
      await expect(
        service.saveIdea(actor, undefined, { ...input, timing: 'night' }),
      ).rejects.toThrow('Chỉ quản trị viên');
    }
    const draft = await service.saveIdea(seller, undefined, input);
    await store.patch<StudioIdea>('studio-idea', draft.id, draft.owner, {
      input: { ...input, timing: 'night' },
    });
    await request(http())
      .post(`/api/agent/studio/ideas/${draft.id}/submit`)
      .set('Authorization', auth(seller))
      .send({ revision: draft.revision })
      .expect(403);
    const scheduled = await approved({ timing: 'night', count: 1 });
    expect(scheduled.state).toBe('approved');
    expect(
      (await store.find<StudioTicket>('studio-ticket', scheduled.ticketId))
        .state,
    ).toBe('scheduled');
  });
  it('blocks scheduled execution if the scheduling account loses its admin role before dispatch', async () => {
    const account = await app
      .get(AgentAuthService)
      .createUser(
        `${randomUUID()}@example.test`,
        'studio-test-password',
        'admin',
      );
    const actor = await store.find<AgentUser>('user', account.id);
    const bytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ee8a30' },
    })
      .png()
      .toBuffer();
    const image = await service.assets.save(actor.id, bytes, {
      name: 'scheduled.png',
      kind: 'source',
      category: 'POD',
    });
    const draft = await service.saveIdea(actor, undefined, {
      ...input,
      sourceId: image.id,
      timing: 'night',
      count: 1,
    });
    const pending = await service.submit(actor, draft.id, draft.revision);
    const idea = await service.decide(
      actor,
      draft.id,
      pending.revision,
      'approved',
      '',
    );
    await store.patch<AgentUser>('user', actor.id, actor.owner, {
      role: 'designer',
    });
    const imageCalls = ai.composeImage.mock.calls.length;
    await worker.tick(new Date(Date.parse(idea.dueAt) + 1000));
    await worker.tick(new Date(Date.parse(idea.dueAt) + 2000));
    const ticket = await store.find<StudioTicket>(
      'studio-ticket',
      idea.ticketId,
    );
    expect(ticket.state).toBe('blocked');
    expect(ai.composeImage.mock.calls.length).toBe(imageCalls);
  });
  it('lets only admins change the daily schedule, freezes approved dates and separates different cutoffs on the same day', async () => {
    const path = '/api/agent/studio/operations/schedule';
    await request(http()).get(path).expect(401);
    await request(http())
      .get(path)
      .set('Authorization', auth(seller))
      .expect(403);
    await request(http())
      .patch(path)
      .set('Authorization', auth(leader))
      .send({ dailyTime: '20:30', revision: 0, reason: 'Not admin' })
      .expect(403);
    const original = await service.schedule();
    expect(original.dailyTime).toBe('22:00');
    for (const time of ['24:00', '09:60', '9:30', '22:00:00'])
      await request(http())
        .patch(path)
        .set('Authorization', auth(admin))
        .send({
          dailyTime: time,
          revision: original.revision,
          reason: 'Invalid hour',
        })
        .expect(400);
    const old = await approved({ timing: 'night', count: 1 });
    try {
      await request(http())
        .patch(path)
        .set('Authorization', auth(admin))
        .send({
          dailyTime: '20:30',
          revision: original.revision,
          reason: 'New company schedule',
        })
        .expect(200);
      await request(http())
        .patch(path)
        .set('Authorization', auth(admin))
        .send({
          dailyTime: '21:30',
          revision: original.revision,
          reason: 'Stale admin tab',
        })
        .expect(409);
      expect((await service.bootstrap(seller)).schedule.dailyTime).toBe(
        '20:30',
      );
      const fresh = await approved({ timing: 'night', count: 1 });
      expect(
        new Date(Date.parse(fresh.dueAt) + 7 * 3600000)
          .toISOString()
          .slice(11, 16),
      ).toBe('20:30');
      expect(
        (await store.find<StudioTicket>('studio-ticket', old.ticketId)).dueAt,
      ).toBe(old.dueAt);
      await worker.tick(new Date(Date.parse(fresh.dueAt) - 1));
      expect(
        (await store.find<StudioTicket>('studio-ticket', fresh.ticketId)).state,
      ).toBe('scheduled');
      await worker.tick(new Date(Date.parse(fresh.dueAt) + 1000));
      expect(
        (await store.find<StudioTicket>('studio-ticket', fresh.ticketId)).state,
      ).toBe('queued');
      const sameDayOld = {
        ...old,
        ticketId: `schedule-${randomUUID()}`,
        dueAt: '2030-01-02T15:00:00.000Z',
      };
      const sameDayNew = {
        ...fresh,
        ticketId: `schedule-${randomUUID()}`,
        dueAt: '2030-01-02T13:30:00.000Z',
      };
      for (const idea of [sameDayOld, sameDayNew]) {
        await service.ensureTicket(idea);
        await service.ensureTicket(idea);
      }
      const first = await store.find<StudioTicket>(
          'studio-ticket',
          sameDayOld.ticketId,
        ),
        second = await store.find<StudioTicket>(
          'studio-ticket',
          sameDayNew.ticketId,
        );
      expect(first.occurrenceId).toBe('night-2030-01-02');
      expect(second.occurrenceId).toBe('night-2030-01-02-2030');
      expect(first.batchId).not.toBe(second.batchId);
      const occurrence = await store.find<{ cutoffAt: string }>(
        'studio-occurrence',
        second.occurrenceId,
      );
      expect(occurrence.cutoffAt).toBe(sameDayNew.dueAt);
      const current = await service.schedule();
      const edits = await Promise.allSettled(
        ['01:00', '23:45'].map((dailyTime) =>
          service.changeSchedule(admin, {
            dailyTime,
            revision: current.revision,
            reason: 'Concurrent admin edits',
          }),
        ),
      );
      expect(edits.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await service.schedule()).revision).toBe(current.revision + 1);
    } finally {
      const current = await service.schedule();
      await service.changeSchedule(admin, {
        dailyTime: '22:00',
        revision: current.revision,
        reason: 'Restore test schedule',
      });
    }
  });
  async function artworkIdea(background: 'white' | 'transparent' = 'white') {
    const printing = await service.saveResource(admin, {
      teamId: team.id,
      type: 'product',
      name: 'Printable',
      code: 'PRINT',
      instructions: 'Flat artwork',
      printSpec: { width: 256, height: 128, dpi: 300, background },
    });
    const current = await store.find<StudioStore>('studio-store', shop.id);
    await store.patch<StudioStore>('studio-store', shop.id, shop.owner, {
      productIds: [...current.productIds, printing.id],
    });
    return approved({ artworkFirst: true, productId: printing.id, count: 1 });
  }
  it('creates independent artwork before the thumbnail, preserves provenance and never reruns either completed request', async () => {
    const incomplete = await service.saveIdea(seller, undefined, {
      ...input,
      artworkFirst: true,
      count: 1,
    });
    await expect(
      service.submit(seller, incomplete.id, incomplete.revision),
    ).rejects.toThrow('quy chuẩn');
    const idea = await artworkIdea();
    await preparePlan(idea.ticketId);
    const slots = await store.query<StudioSlot>(
      'studio-slot',
      { ticketId: idea.ticketId },
      10,
    );
    const artwork = slots.find((s) => s.role === 'artwork'),
      thumbnail = slots.find((s) => s.role === 'thumbnail');
    expect(slots).toHaveLength(2);
    const calls = ai.composeImage.mock.calls.length;
    await worker.execute(thumbnail.id, seller.id);
    expect(ai.composeImage.mock.calls.length).toBe(calls);
    await worker.execute(artwork.id, seller.id);
    const raw = await store.find<StudioSlot>('studio-slot', artwork.id);
    const bytes = await service.assets.read(seller.id, raw.resultId);
    expect(await sharp(bytes.buffer).metadata()).toMatchObject({
      width: 256,
      height: 128,
      density: 300,
    });
    await worker.tick();
    await worker.execute(thumbnail.id, seller.id);
    await worker.tick();
    const detail = await service.detail(seller, idea.id);
    expect(detail.slots).toHaveLength(1);
    expect(detail.artworks).toHaveLength(1);
    expect(detail.slots[0].artworkId).toBe(raw.resultId);
    expect(
      (await store.find<Asset>('asset', detail.slots[0].resultId)).parentId,
    ).toBe(raw.resultId);
    const thumbnailRequest = ai.composeImage.mock.calls[calls + 1][0] as {
      prompt: string;
      images: { base64: string; mimeType: string }[];
    };
    expect(thumbnailRequest.prompt).toContain('ARTWORK GỐC');
    expect(thumbnailRequest.images).toHaveLength(2);
    expect(thumbnailRequest.images[0]).toEqual({
      base64: bytes.buffer.toString('base64'),
      mimeType: 'image/png',
    });
    await service.reviewOutput(
      leader,
      idea.ticketId,
      raw.resultId,
      'approved',
      'Checked dimensions and content',
    );
    await service.reviewOutput(
      leader,
      idea.ticketId,
      detail.slots[0].resultId,
      'approved',
      'Checked mockup',
    );
    const exported = await request(http())
      .get(`/api/agent/studio/assets/${raw.resultId}?format=png`)
      .set('Authorization', auth(leader))
      .expect(200);
    expect(await sharp(exported.body as Buffer).metadata()).toMatchObject({
      density: 300,
      width: 256,
      height: 128,
    });
    await worker.execute(artwork.id, seller.id);
    await worker.execute(thumbnail.id, seller.id);
    expect(ai.composeImage.mock.calls.length - calls).toBe(2);
    const payload = await mockupInput();
    payload.productId = idea.input.productId;
    payload.sources[0].assetId = raw.resultId;
    payload.sources[0].ticketId = idea.ticketId;
    expect(
      (await app.get(StudioMockupService).create(seller, payload)).sources[0]
        .image.id,
    ).toBe(raw.resultId);
  });
  it('blocks thumbnail generation after uncertain artwork and refuses approval when required transparency is missing', async () => {
    const idea = await artworkIdea('transparent');
    await preparePlan(idea.ticketId);
    const slots = await store.query<StudioSlot>(
      'studio-slot',
      { ticketId: idea.ticketId },
      10,
    );
    const artwork = slots.find((s) => s.role === 'artwork');
    await worker.execute(artwork.id, seller.id);
    const saved = await store.find<StudioSlot>('studio-slot', artwork.id);
    await expect(
      service.reviewOutput(
        leader,
        idea.ticketId,
        saved.resultId,
        'approved',
        '',
      ),
    ).rejects.toThrow('chưa đạt');
    const transparentIdea = await artworkIdea('transparent');
    await preparePlan(transparentIdea.ticketId);
    const alphaSlot = (
      await store.query<StudioSlot>(
        'studio-slot',
        { ticketId: transparentIdea.ticketId, role: 'artwork' },
        1,
      )
    )[0];
    ai.composeImage.mockResolvedValueOnce(
      await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: { r: 255, g: 128, b: 0, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer(),
    );
    await worker.execute(alphaSlot.id, seller.id);
    const alphaResult = (
      await store.find<StudioSlot>('studio-slot', alphaSlot.id)
    ).resultId;
    await service.reviewOutput(
      leader,
      transparentIdea.ticketId,
      alphaResult,
      'approved',
      'Verified alpha',
    );
    await request(http())
      .get(`/api/agent/studio/assets/${alphaResult}?format=jpg`)
      .set('Authorization', auth(leader))
      .expect(400);
    const unknown = await artworkIdea();
    await preparePlan(unknown.ticketId);
    const pending = await store.query<StudioSlot>(
      'studio-slot',
      { ticketId: unknown.ticketId },
      10,
    );
    const raw = pending.find((s) => s.role === 'artwork'),
      thumbnail = pending.find((s) => s.role === 'thumbnail');
    ai.composeImage.mockRejectedValueOnce(new Error('Unknown artwork outcome'));
    await worker.execute(raw.id, seller.id);
    await worker.tick();
    const calls = ai.composeImage.mock.calls.length;
    await worker.execute(thumbnail.id, seller.id);
    await worker.execute(raw.id, seller.id);
    expect(ai.composeImage.mock.calls.length).toBe(calls);
    expect(
      (await store.find<StudioSlot>('studio-slot', thumbnail.id)).errorCode,
    ).toBe('STUDIO_DEPENDENCY_FAILED');
    await service.cancel(seller, unknown.ticketId).catch(() => undefined);
  });
  it('counts actual work with store ACL, pages resources and shares explicitly submitted mockup inputs with the Leader', async () => {
    const dashboard = await service.dashboard(seller);
    expect(dashboard.storeCount).toBeGreaterThan(0);
    expect(dashboard.outputs.artworks).toBeGreaterThanOrEqual(2);
    const hidden = await service.dashboard(outsider);
    expect(await store.studioVisibleStoreIds(outsider)).not.toContain(shop.id);
    expect(hidden.ideas.approved).toBeUndefined();
    expect(hidden.outputs.artworks).toBeUndefined();
    await request(http())
      .get(`/api/agent/studio/resources?teamId=${team.id}&page=1`)
      .set('Authorization', auth(outsider))
      .expect(200);
    await expect(
      service.catalog(
        { ...outsider, id: randomUUID() },
        { teamId: team.id, page: 1 },
      ),
    ).rejects.toThrow();
    const catalog = await service.catalog(admin, {
      teamId: team.id,
      type: 'product',
      q: 'Print',
      page: 1,
    });
    expect(catalog.items.length).toBeGreaterThan(0);
    expect(catalog.items.length).toBeLessThanOrEqual(24);
    expect(catalog.items.every((r) => r.type === 'product')).toBe(true);
    const uploaded = await service.assets.save(
      seller.id,
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#9a4' },
      })
        .png()
        .toBuffer(),
      { name: 'Private mockup source', kind: 'source', category: 'POD' },
    );
    const payload = await mockupInput();
    payload.sources[0].assetId = uploaded.id;
    await app.get(StudioMockupService).create(seller, payload);
    await request(http())
      .get(`/api/agent/studio/assets/${uploaded.id}?preview=1`)
      .set('Authorization', auth(leader))
      .expect(200);
    await request(http())
      .get(`/api/agent/studio/assets/${uploaded.id}?preview=1`)
      .set('Authorization', auth(outsider))
      .expect(404);
  });
  it('versions arbitrary products and scene assets without mutating earlier job snapshots or encryption ownership', async () => {
    const response = await request(http())
      .post('/api/agent/studio/resources')
      .set('Authorization', auth(admin))
      .send({
        teamId: team.id,
        type: 'product',
        name: 'Sản phẩm tự đặt tên',
        code: 'ANY-CODE',
        instructions: 'Quy tắc riêng',
        printSpec: { width: 500, height: 800, dpi: 300, background: 'white' },
      })
      .expect(201);
    const original = response.body as StudioResource;
    const next = await service.saveResource(admin, {
      teamId: team.id,
      type: 'product',
      name: original.name,
      code: original.code,
      instructions: 'Bản cập nhật',
      previousId: original.id,
      printSpec: { width: 600, height: 800, dpi: 300, background: 'white' },
    });
    expect(next.previousId).toBe(original.id);
    expect(next.versionNumber).toBe(2);
    expect(
      (await store.find<StudioResource>('studio-resource', original.id))
        .printSpec?.width,
    ).toBe(500);
    const versions = await app
      .get(StudioLibraryService)
      .versions(admin, next.id);
    expect(versions.map((r) => r.id)).toEqual(
      expect.arrayContaining([original.id, next.id]),
    );
    const scene = await service.saveResource(admin, {
      teamId: team.id,
      type: 'scene',
      name: 'Bối cảnh phiên bản',
      code: 'DYNAMIC-SCENE',
      instructions: 'Giữ nền',
      assetId: master.id,
    });
    const cloned = await service.saveResource(admin, {
      teamId: team.id,
      type: 'scene',
      name: scene.name,
      code: scene.code,
      instructions: 'Mô tả mới',
      previousId: scene.id,
    });
    expect(cloned.assetId).not.toBe(scene.assetId);
    expect(
      (await service.assets.read(cloned.owner, cloned.assetId)).asset.sha256,
    ).toBe(master.sha256);
    const candidates = await service.catalog(admin, {
      teamId: team.id,
      q: 'ANY-CODE',
      page: 1,
    });
    expect(candidates.items).toHaveLength(2);
    await request(http())
      .post('/api/agent/studio/resources')
      .set('Authorization', auth(admin))
      .send({
        teamId: team.id,
        type: 'product',
        name: 'Too big',
        code: 'TOO-BIG',
        instructions: '',
        printSpec: { width: 8192, height: 8192, dpi: 300, background: 'white' },
      })
      .expect(400);
  });
});
