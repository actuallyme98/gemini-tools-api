import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { AgentStore } from '../src/agent/agent.store';
import { AgentAssetsService } from '../src/agent/agent-assets.service';
import { AgentAuthService, AgentGuard } from '../src/agent/agent-auth.service';
import { ConversationSharingService } from '../src/agent/conversation-sharing.service';
import {
  ConversationSharingController,
  SharedConversationController,
} from '../src/agent/conversation-sharing.controller';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { AuditInterceptor } from '../src/audit/audit.interceptor';
import { AuditLogService } from '../src/audit/audit-log.service';
import { R2Service } from '../src/r2/r2.service';
import type {
  AgentUser,
  Asset,
  Conversation,
  Run,
  Step,
} from '../src/agent/agent.types';

const sharedBody = (response: { body: unknown }) =>
  response.body as Awaited<ReturnType<ConversationSharingService['read']>>;

describe('Conversation sharing (real MongoDB and encrypted images, no AI calls)', () => {
  let mongo: MongoMemoryServer, app: INestApplication, store: AgentStore;
  let owner: AgentUser,
    outsider: AgentUser,
    ownerToken: string,
    outsiderToken: string;
  let source: Asset, target: Asset, unrelated: Asset, foreign: Asset;
  let conversation: Conversation, run: Run;
  const blobs = new Map<string, Buffer>();
  const events: unknown[] = [];
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const privatePath = () => `/api/agent/conversations/${conversation.id}/share`;
  const publicPath = () => `/api/agent/shared/${conversation.id}`;
  const publish = async (includeImages = true) => {
    const response = await request(http())
      .post(privatePath())
      .auth(ownerToken, { type: 'bearer' })
      .send({ includeImages })
      .expect(201);
    return response.body as {
      token: string;
      sharedAt: string;
      messageCount: number;
    };
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const audit = {
      write: (event: string, details: unknown, context?: unknown) => {
        events.push({ event, details, context });
        return Promise.resolve();
      },
      run: <T>(_context: unknown, callback: () => T) => callback(),
    };
    const module = await Test.createTestingModule({
      controllers: [
        ConversationSharingController,
        SharedConversationController,
      ],
      providers: [
        AgentStore,
        AgentAuthService,
        AgentGuard,
        AgentAssetsService,
        ConversationSharingService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            AGENT_ENABLED: true,
            QUEUE_ENABLED: false,
            MONGODB_URI: mongo.getUri(),
            AGENT_ASSET_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
          }),
        },
        { provide: AuditLogService, useValue: audit },
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
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new ApiExceptionFilter());
    app.useGlobalInterceptors(
      new AuditInterceptor(audit as unknown as AuditLogService),
    );
    await app.init();
    store = app.get(AgentStore);
    const auth = app.get(AgentAuthService);
    await auth.createUser(
      'owner@example.com',
      'sharing-test-password',
      'designer',
    );
    await auth.createUser(
      'outsider@example.com',
      'sharing-test-password',
      'designer',
    );
    [owner, outsider] = await Promise.all(
      ['owner', 'outsider'].map(
        async (prefix) =>
          (
            await store.query<AgentUser>(
              'user',
              { email: `${prefix}@example.com` },
              1,
            )
          )[0],
      ),
    );
    ownerToken = (
      await auth.login(owner.email, 'sharing-test-password', 'owner-ip')
    ).token;
    outsiderToken = (
      await auth.login(outsider.email, 'sharing-test-password', 'outsider-ip')
    ).token;
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: '#f58216' },
    })
      .png()
      .toBuffer();
    const assets = app.get(AgentAssetsService);
    source = await assets.save(owner.id, png, {
      name: 'source.png',
      kind: 'source',
      category: 'POD',
    });
    target = await assets.save(owner.id, png, {
      name: 'reference.png',
      kind: 'reference',
      category: 'POD',
    });
    unrelated = await assets.save(owner.id, png, {
      name: 'private.png',
      kind: 'source',
      category: 'Private',
    });
    foreign = await assets.save(outsider.id, png, {
      name: 'foreign.png',
      kind: 'source',
      category: 'Private',
    });
  }, 30000);

  beforeEach(async () => {
    conversation = await store.insert(
      'conversation',
      store.create<Conversation>(owner.id, {
        title: 'Christmas mockups',
        pinnedRequirements: ['PRIVATE PINNED REQUIREMENT'],
        messages: [],
      }),
    );
    run = await store.insert(
      'run',
      store.create<Run>(owner.id, {
        conversationId: conversation.id,
        brief: 'Replace ornament',
        operation: 'mockup_ai',
        state: 'review',
        provider: 'private-provider',
        imageModel: 'private-model',
        sourceIds: [source.id],
        targetIds: [target.id],
        templateIds: [],
        count: 1,
        productType: 'POD',
        research: 'PRIVATE RESEARCH',
        researchSources: [],
        summary: 'Giữ nguyên bối cảnh tham chiếu',
        questions: [],
        items: [
          {
            title: 'Final prompt',
            prompt: 'Thay ornament nguồn vào ảnh tham chiếu. Không watermark.',
          },
        ],
        analyses: { secret: 'PRIVATE ANALYSIS' },
        knowledgeSources: [
          {
            id: randomUUID(),
            title: 'PRIVATE KNOWLEDGE',
            revision: 1,
            excerpt: 'PRIVATE EXCERPT',
          },
        ],
        validateVisually: true,
        requestId: randomUUID(),
      }),
    );
    await store.appendMessage(conversation.id, owner.id, {
      id: 'user-1',
      role: 'user',
      text: 'Thay ornament <script>alert(1)</script>',
      runId: run.id,
      createdAt: '2026-10-24T00:00:01.000Z',
    });
    await store.appendMessage(conversation.id, owner.id, {
      id: 'assistant-1',
      role: 'assistant',
      text: 'Đã lập kế hoạch.',
      runId: run.id,
      createdAt: '2026-10-24T00:00:02.000Z',
    });
    await store.insert(
      'step',
      store.create<Step>(owner.id, {
        runId: run.id,
        type: 'image',
        state: 'done',
        index: 0,
        resultId: target.id,
        requestId: randomUUID(),
      }),
    );
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('requires authentication and ownership for managing links', async () => {
    await request(http())
      .post(privatePath())
      .send({ includeImages: true })
      .expect(401);
    for (const method of ['get', 'post', 'delete'] as const) {
      await request(http())
        [method](privatePath())
        .auth(outsiderToken, { type: 'bearer' })
        .send(method === 'post' ? { includeImages: true } : {})
        .expect(404);
    }
    const status = await request(http())
      .get(privatePath())
      .auth(ownerToken, { type: 'bearer' })
      .expect(200);
    expect(status.body).toEqual({ share: null });
  });

  it('requires explicit valid image-sharing choice and nonempty chat', async () => {
    for (const body of [
      {},
      { includeImages: 'false' },
      { includeImages: true, owner: outsider.id },
    ])
      await request(http())
        .post(privatePath())
        .auth(ownerToken, { type: 'bearer' })
        .send(body)
        .expect(400);
    await store.remove('message', `${conversation.id}:user-1`);
    await store.remove('message', `${conversation.id}:assistant-1`);
    await request(http())
      .post(privatePath())
      .auth(ownerToken, { type: 'bearer' })
      .send({ includeImages: false })
      .expect(400);
  });

  it('publishes a safe public snapshot without account, storage, context or provider metadata', async () => {
    const share = await publish();
    const response = await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(200);
    expect(sharedBody(response).messages).toHaveLength(2);
    expect(sharedBody(response).runs[0].items[0].prompt).toContain(
      'Không watermark',
    );
    expect(
      sharedBody(response)
        .assets.map((asset) => asset.id)
        .sort(),
    ).toEqual([source.id, target.id].sort());
    const json = JSON.stringify(response.body);
    for (const hidden of [
      owner.id,
      owner.email,
      'storageKey',
      '"iv"',
      '"tag"',
      'PRIVATE',
      'private-provider',
      'private-model',
      'passwordHash',
      'estimatedTokens',
      'requestId',
    ])
      expect(json).not.toContain(hidden);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-robots-tag']).toContain('noindex');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    const status = await request(http())
      .get(privatePath())
      .auth(ownerToken, { type: 'bearer' })
      .expect(200);
    expect((status.body as { share: { token: string } }).share.token).toBe(
      share.token,
    );
    const stored = await store.find<{ nonce: string }>(
      'conversation-share',
      conversation.id,
    );
    expect(JSON.stringify(stored)).not.toContain(share.token);
  });

  it('cannot open a link without its signature or substitute another conversation ID', async () => {
    const share = await publish();
    await request(http()).get(publicPath()).expect(404);
    const last = share.token.at(-1) === 'a' ? 'b' : 'a';
    await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token.slice(0, -1) + last)
      .expect(404);
    await request(http())
      .get(`/api/agent/shared/${randomUUID()}`)
      .set('X-Share-Token', share.token)
      .expect(404);
    await request(http())
      .get(publicPath())
      .set('X-Share-Token', 'x'.repeat(300))
      .expect(404);
  });

  it('freezes text and plans until explicitly updated, preserving the link on refresh', async () => {
    const share = await publish();
    const first = await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(200);
    await store.appendMessage(conversation.id, owner.id, {
      id: 'later',
      role: 'user',
      text: 'TIN NHẮN MỚI',
      createdAt: '2026-10-24T00:00:03.000Z',
    });
    await store.patch<Run>('run', run.id, owner.id, {
      summary: 'KẾ HOẠCH ĐÃ ĐỔI',
    });
    const frozen = await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(200);
    expect(frozen.body).toEqual(first.body);
    const refreshed = await publish();
    expect(refreshed.token).toBe(share.token);
    const latest = await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(200);
    expect(sharedBody(latest).messages).toHaveLength(3);
    expect(sharedBody(latest).runs[0].summary).toBe('KẾ HOẠCH ĐÃ ĐỔI');
    await request(http())
      .get(publicPath())
      .query({ after: 40, version: sharedBody(first).version })
      .set('X-Share-Token', share.token)
      .expect(409);
  });

  it('archives the full history, not just the latest loaded page', async () => {
    for (let index = 3; index <= 85; index++)
      await store.appendMessage(conversation.id, owner.id, {
        id: `message-${index}`,
        role: 'user',
        text: `Tin ${index}`,
        createdAt: new Date(Date.UTC(2026, 9, 24, 0, 0, index)).toISOString(),
      });
    const share = await publish(false);
    expect(share.messageCount).toBe(85);
    const seen: string[] = [];
    let after = 0;
    do {
      const response = await request(http())
        .get(publicPath())
        .query({ after })
        .set('X-Share-Token', share.token)
        .expect(200);
      seen.push(...sharedBody(response).messages.map((message) => message.id));
      after = sharedBody(response).nextCursor;
    } while (after !== null);
    expect(seen).toHaveLength(85);
    expect(new Set(seen).size).toBe(85);
    expect(seen[0]).toBe('user-1');
    expect(seen.at(-1)).toBe('message-85');
    await request(http())
      .get(publicPath())
      .query({ after: -1 })
      .set('X-Share-Token', share.token)
      .expect(400);
  });

  it('serves only linked previews and never unrelated or foreign assets', async () => {
    await store.appendMessage(conversation.id, owner.id, {
      id: 'bad-attachment',
      role: 'user',
      text: 'An image from another account must stay private',
      createdAt: '2026-10-24T00:00:03.000Z',
      attachments: { sourceIds: [foreign.id], targetIds: [], templateIds: [] },
    });
    const share = await publish();
    const response = await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain(foreign.id);
    const preview = await request(http())
      .get(`${publicPath()}/assets/${source.id}/preview`)
      .set('X-Share-Token', share.token)
      .expect(200)
      .expect('Content-Type', /image\/webp/);
    const metadata = await sharp(preview.body as Buffer).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.width).toBeLessThanOrEqual(512);
    for (const id of [unrelated.id, foreign.id])
      await request(http())
        .get(`${publicPath()}/assets/${id}/preview`)
        .set('X-Share-Token', share.token)
        .expect(404);
    await request(http())
      .get(`${publicPath()}/assets/${source.id}/content`)
      .set('X-Share-Token', share.token)
      .expect(404);
    await request(http())
      .get(`${publicPath()}/assets/${source.id}/preview`)
      .expect(404);
  });

  it('can exclude images and remove image access when refreshing a link', async () => {
    const share = await publish();
    await publish(false);
    const response = await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(200);
    expect(sharedBody(response).includeImages).toBe(false);
    expect(sharedBody(response).assets).toEqual([]);
    expect(
      sharedBody(response).messages.every(
        (message: { images: unknown[] }) => message.images.length === 0,
      ),
    ).toBe(true);
    expect(sharedBody(response).runs[0].resultIds).toEqual([]);
    await request(http())
      .get(`${publicPath()}/assets/${source.id}/preview`)
      .set('X-Share-Token', share.token)
      .expect(404);
  });

  it('does not grant image access to a run outside the captured transcript', async () => {
    const hidden = { ...run, id: randomUUID(), summary: 'NOT IN TRANSCRIPT' };
    await store.insert('run', hidden);
    await store.insert(
      'step',
      store.create<Step>(owner.id, {
        runId: hidden.id,
        type: 'image',
        state: 'done',
        index: 0,
        resultId: unrelated.id,
        requestId: randomUUID(),
      }),
    );
    const share = await publish();
    const response = await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(200);
    expect(sharedBody(response).runs.map((item) => item.id)).not.toContain(
      hidden.id,
    );
    await request(http())
      .get(`${publicPath()}/assets/${unrelated.id}/preview`)
      .set('X-Share-Token', share.token)
      .expect(404);
  });

  it('revokes text and images immediately and issues a different link if shared again', async () => {
    const share = await publish();
    await request(http())
      .delete(privatePath())
      .auth(ownerToken, { type: 'bearer' })
      .expect(204);
    await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(404);
    await request(http())
      .get(`${publicPath()}/assets/${source.id}/preview`)
      .set('X-Share-Token', share.token)
      .expect(404);
    const next = await publish();
    expect(next.token).not.toBe(share.token);
    await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(404);
    await request(http())
      .get(publicPath())
      .set('X-Share-Token', next.token)
      .expect(200);
  });

  it('blocks shared content when the owner is disabled or the conversation is removed', async () => {
    const share = await publish();
    await store.patch<AgentUser>('user', owner.id, owner.id, {
      disabled: true,
    });
    try {
      await request(http())
        .get(publicPath())
        .set('X-Share-Token', share.token)
        .expect(404);
    } finally {
      await store.patch<AgentUser>('user', owner.id, owner.id, {
        disabled: false,
      });
    }
    await store.remove('conversation', conversation.id);
    await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(404);
  });

  it('keeps signatures out of stored snapshots and HTTP audit paths', async () => {
    const share = await publish();
    await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(200);
    expect(JSON.stringify(events)).not.toContain(share.token);
    expect(JSON.stringify(events)).not.toContain(share.token.split('.')[1]);
    const content = await store.query(
      'conversation-share-content',
      { owner: owner.id },
      100,
    );
    expect(JSON.stringify(content)).not.toContain(share.token);
  });

  it('keeps the existing snapshot when a new snapshot exceeds the size limit', async () => {
    const share = await publish(false);
    await store.appendMessage(conversation.id, owner.id, {
      id: 'too-large',
      role: 'user',
      text: 'x'.repeat(6 * 1024 * 1024 + 1),
      createdAt: '2026-10-24T00:00:03.000Z',
    });
    const response = await request(http())
      .post(privatePath())
      .auth(ownerToken, { type: 'bearer' })
      .send({ includeImages: false })
      .expect(400);
    expect((response.body as { code: string }).code).toBe(
      'CONVERSATION_SHARE_TOO_LARGE',
    );
    const unchanged = await request(http())
      .get(publicPath())
      .set('X-Share-Token', share.token)
      .expect(200);
    expect(sharedBody(unchanged).messages).toHaveLength(2);
  });

  it('publishing concurrently leaves one readable snapshot without orphaned duplicate content', async () => {
    const responses = await Promise.all(
      [true, false].map((includeImages) =>
        request(http())
          .post(privatePath())
          .auth(ownerToken, { type: 'bearer' })
          .send({ includeImages }),
      ),
    );
    expect(responses.some((response) => response.status === 201)).toBe(true);
    expect(
      responses.every((response) => [201, 409].includes(response.status)),
    ).toBe(true);
    const current = await request(http())
      .get(privatePath())
      .auth(ownerToken, { type: 'bearer' })
      .expect(200);
    const token = (current.body as { share: { token: string } }).share.token;
    await request(http())
      .get(publicPath())
      .set('X-Share-Token', token)
      .expect(200);
    const contents = await store.query(
      'conversation-share-content',
      { owner: owner.id },
      200,
    );
    const manifest = await store.find<{ snapshotId: string }>(
      'conversation-share',
      conversation.id,
    );
    expect(
      contents.filter(
        (item: { id: string }) => item.id === manifest?.snapshotId,
      ),
    ).toHaveLength(1);
    // Every content record still in the database must be the active snapshot of its manifest.
    const manifests = await store.query<{
      snapshotId: string;
      revoked: boolean;
    }>('conversation-share', { owner: owner.id }, 200);
    const active = new Set(
      manifests.filter((item) => !item.revoked).map((item) => item.snapshotId),
    );
    expect(contents.every((item: { id: string }) => active.has(item.id))).toBe(
      true,
    );
  });

  it('rate limits costly public reads and repeated snapshot creation', async () => {
    const share = await publish(false);
    const rate = jest.spyOn(store, 'loginAttempt').mockResolvedValue(1201);
    try {
      await request(http())
        .post(privatePath())
        .auth(ownerToken, { type: 'bearer' })
        .send({ includeImages: false })
        .expect(429);
      await request(http())
        .get(publicPath())
        .set('X-Share-Token', share.token)
        .expect(429);
      await request(http())
        .get(`${publicPath()}/assets/${source.id}/preview`)
        .set('X-Share-Token', share.token)
        .expect(429);
    } finally {
      rate.mockRestore();
    }
  });
});
