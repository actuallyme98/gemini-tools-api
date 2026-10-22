import { TaskQueueService } from '../src/queue/task-queue.service';
import { TestTaskQueue } from './queue-fixture';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AgentStore } from '../src/agent/agent.store';
import {
  AgentAuthService,
  AgentAdminGuard,
  AgentGuard,
} from '../src/agent/agent-auth.service';
import { AgentAuthController } from '../src/agent/agent.controller';
import { AdminController } from '../src/agent/admin.controller';
import { AdminService } from '../src/agent/admin.service';
import { AgentService } from '../src/agent/agent.service';
import { AgentAssetsService } from '../src/agent/agent-assets.service';
import { AIService } from '../src/ai/ai.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import type {
  AdminAudit,
  AgentUser,
  Asset,
  CompanySettings,
  Run,
  Session,
  Step,
} from '../src/agent/agent.types';

describe('Company administration (real MongoDB)', () => {
  let app: INestApplication,
    mongo: MongoMemoryServer,
    directory: string,
    store: AgentStore,
    auth: AgentAuthService;
  let root: AgentUser, staff: AgentUser, rootToken: string, staffToken: string;
  const password = 'private-password-at-least-12';
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const get = (url: string, token = rootToken) =>
    request(http())
      .get('/api/agent/admin' + url)
      .set('Authorization', `Bearer ${token}`);
  const patch = (url: string, body: object, token = rootToken) =>
    request(http())
      .patch('/api/agent/admin' + url)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const post = (url: string, body: object, token = rootToken) =>
    request(http())
      .post('/api/agent/admin' + url)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const account = async (id = staff.id) =>
    await store.find<AgentUser>('user', id);
  const login = async (email: string, pass = password) =>
    (await auth.login(email, pass, randomUUID())).token;
  const seedRun = async (state: Run['state'] = 'queued') => {
    const run = store.create<Run>(staff.id, {
      conversationId: randomUUID(),
      state,
      operation: 'mockup_ai',
      provider: 'shopaikey',
      count: 1,
      requestId: randomUUID(),
      productType: 'Ornament',
      brief: 'PRIVATE PROMPT',
      items: [],
      sourceIds: [],
      targetIds: [],
      templateIds: [],
      research: '',
      researchSources: [],
      analyses: {},
      validateVisually: true,
      summary: '',
      questions: [],
    });
    await store.insert('run', run);
    const step = store.create<Step>(staff.id, {
      runId: run.id,
      type: 'image',
      state: 'queued',
      index: 0,
      requestId: randomUUID(),
    });
    await store.insert('step', step);
    return { run, step };
  };
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lcg-admin-'));
    const module = await Test.createTestingModule({
      controllers: [AdminController, AgentAuthController],
      providers: [
        AgentStore,
        AgentAuthService,
        AgentGuard,
        AgentAdminGuard,
        AdminService,
        AgentService,
        { provide: TaskQueueService, useValue: new TestTaskQueue() },
        AuditLogService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            AGENT_ENABLED: true,
            MONGODB_URI: mongo.getUri(),
            MONGODB_DATABASE: 'admin_test',
            AUDIT_LOG_DIR: directory,
            GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
            GOOGLE_ALLOWED_DOMAINS: 'lcgmedia.uk',
          }),
        },
        { provide: AgentAssetsService, useValue: {} },
        {
          provide: AIService,
          useValue: {
            getProviders: () => ({
              providers: [
                { id: 'shopaikey', available: true, capabilities: ['image'] },
              ],
            }),
          },
        },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    store = app.get(AgentStore);
    auth = app.get(AgentAuthService);
    root = await store.find<AgentUser>(
      'user',
      (await auth.createUser('root@lcgmedia.uk', password, 'admin')).id,
    );
    staff = await store.find<AgentUser>(
      'user',
      (await auth.createUser('staff@lcgmedia.uk', password, 'designer')).id,
    );
    rootToken = await login(root.email);
    staffToken = await login(staff.email);
    await get('/settings').expect(200);
  });
  afterAll(async () => {
    await app?.close();
    await store?.onApplicationShutdown();
    await mongo?.stop();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it('rejects anonymous and designer access on every administration endpoint', async () => {
    for (const url of [
      '/overview',
      '/users',
      '/runs',
      '/audit',
      '/settings',
      '/diagnostics?day=2026-10-23',
    ]) {
      await get(url, '').expect(401);
      await get(url, staffToken).expect(403);
    }
    await post(
      '/users',
      { email: 'attacker@lcgmedia.uk', password, role: 'admin' },
      staffToken,
    ).expect(403);
    await patch('/settings', {}, staffToken).expect(403);
  });
  it('returns paginated safe accounts, role/status/search filters and usage without hashes or Google subjects', async () => {
    const result = await get(
      '/users?limit=1&search=STAFF&role=designer&disabled=false',
    ).expect(200);
    expect(result.body as unknown).toMatchObject({
      total: 1,
      page: 1,
      limit: 1,
      protectedAdminId: root.id,
      items: [
        {
          email: staff.email,
          role: 'designer',
          disabled: false,
          hasPassword: true,
          usage: { session: { count: 1 } },
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toMatch(
      /passwordHash|googleSub|authVersion/,
    );
    expect(result.headers['cache-control']).toBe('no-store');
    await get('/users?page=0').expect(400);
    await get('/users?limit=10000').expect(400);
    await get('/users?role=owner').expect(400);
    await get('/users?unexpected=x').expect(400);
  });
  it('creates accounts and journals old and new create endpoints without passwords', async () => {
    await post('/users', {
      email: 'new@lcgmedia.uk',
      password,
      role: 'designer',
    }).expect(201);
    await request(http())
      .post('/api/agent/auth/users')
      .set('Authorization', `Bearer ${rootToken}`)
      .send({ email: 'legacy@lcgmedia.uk', password, role: 'designer' })
      .expect(201);
    const result = await get('/audit?search=account.create').expect(200);
    expect((result.body as { total: number }).total).toBe(2);
    expect(JSON.stringify(result.body)).not.toContain(password);
    await post('/users', {
      email: 'new@lcgmedia.uk',
      password,
      role: 'designer',
    }).expect(409);
  });
  it('protects the root administrator and prevents self lockout even with forged requests', async () => {
    for (const change of [{ role: 'designer' }, { disabled: true }])
      await patch(`/users/${root.id}`, {
        ...change,
        reason: 'root protection',
        updatedAt: (await account(root.id)).updatedAt,
      }).expect(409);
    const another = await auth.createUser(
      'other-admin@lcgmedia.uk',
      password,
      'admin',
    );
    const token = await login(another.email);
    await patch(
      `/users/${root.id}`,
      {
        disabled: true,
        reason: 'cross admin protection',
        updatedAt: (await account(root.id)).updatedAt,
      },
      token,
    ).expect(409);
    await patch(
      `/users/${another.id}`,
      {
        role: 'designer',
        reason: 'self protection',
        updatedAt: (await account(another.id)).updatedAt,
      },
      token,
    ).expect(409);
  });
  it('locks immediately, invalidates old sessions permanently, and permits a new login after unlock', async () => {
    await patch(`/users/${staff.id}`, {
      disabled: true,
      reason: 'employee offboarding',
      updatedAt: (await account()).updatedAt,
    }).expect(200);
    await request(http())
      .get('/api/agent/auth/me')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(401);
    await expect(login(staff.email)).rejects.toMatchObject({
      message: expect.stringContaining('bị khóa') as unknown,
    });
    await patch(`/users/${staff.id}`, {
      disabled: false,
      reason: 'employee restored',
      updatedAt: (await account()).updatedAt,
    }).expect(200);
    await request(http())
      .get('/api/agent/auth/me')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(401);
    staffToken = await login(staff.email);
    await request(http())
      .get('/api/agent/auth/me')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
  });
  it('uses a session generation to reject a late old login even if its session was inserted after revocation', async () => {
    const cleanup = jest
      .spyOn(store, 'revokeUserSessions')
      .mockRejectedValueOnce(new Error('cleanup unavailable'));
    const oldVersion = (await account()).authVersion ?? 0;
    await patch(`/users/${staff.id}`, {
      revokeSessions: true,
      reason: 'security response',
      updatedAt: (await account()).updatedAt,
    }).expect(200);
    const session = store.create<Session>(staff.id, {
      authVersion: oldVersion,
      expiresAt: Date.now() + 3600000,
    });
    const lateToken = randomBytes(32).toString('hex');
    session.id = createHash('sha256').update(lateToken).digest('hex');
    await store.insert('session', session);
    expect((await account()).authVersion).toBe(oldVersion + 1);
    cleanup.mockRestore();
    await request(http())
      .get('/api/agent/auth/me')
      .set('Authorization', `Bearer ${lateToken}`)
      .expect(401);
    await request(http())
      .get('/api/agent/auth/me')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(401);
  });
  it('changes roles and resets passwords with optimistic locking and complete audit records', async () => {
    const before = await account();
    await patch(`/users/${staff.id}`, {
      role: 'admin',
      reason: 'temporary access',
      updatedAt: before.updatedAt,
    }).expect(200);
    await patch(`/users/${staff.id}`, {
      disabled: true,
      reason: 'stale update',
      updatedAt: before.updatedAt,
    }).expect(409);
    await patch(`/users/${staff.id}`, {
      password: 'new-private-password-456',
      reason: 'password reset',
      updatedAt: (await account()).updatedAt,
    }).expect(200);
    await expect(login(staff.email)).rejects.toMatchObject({
      message: 'Email hoặc mật khẩu không đúng.',
    });
    staffToken = await login(staff.email, 'new-private-password-456');
    await patch(`/users/${staff.id}`, {
      role: 'designer',
      reason: 'temporary access ended',
      updatedAt: (await account()).updatedAt,
    }).expect(200);
    await get('/users', staffToken).expect(401);
    const logs = await store.query<AdminAudit>('admin-audit', {
      target: staff.id,
    });
    expect(
      logs.some(
        (row) =>
          row.action === 'account.password_reset' && row.outcome === 'success',
      ),
    ).toBe(true);
    expect(logs.some((row) => row.outcome === 'failed')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('new-private-password-456');
  });
  it('validates reasons, IDs, mutually exclusive changes and password limits', async () => {
    const updatedAt = (await account()).updatedAt;
    await patch(`/users/${staff.id}`, { disabled: true, updatedAt }).expect(
      400,
    );
    await patch(`/users/${staff.id}`, {
      disabled: true,
      role: 'admin',
      reason: 'bad combined action',
      updatedAt,
    }).expect(400);
    await patch(`/users/${staff.id}`, {
      password: 'short',
      reason: 'weak password',
      updatedAt,
    }).expect(400);
    await patch('/users/not-a-user', {
      disabled: true,
      reason: 'bad id',
      updatedAt,
    }).expect(400);
  });
  it('keeps an uncertain database write as pending rather than claiming it safely failed', async () => {
    const before = await account();
    const patchWrite = jest
      .spyOn(store, 'patch')
      .mockRejectedValueOnce(new Error('Write acknowledgment lost'));
    await patch(`/users/${staff.id}`, {
      disabled: true,
      reason: 'uncertain update',
      updatedAt: before.updatedAt,
    }).expect(500);
    patchWrite.mockRestore();
    const entries = await store.query<AdminAudit>('admin-audit', {
      target: staff.id,
      outcome: 'pending',
    });
    expect(
      entries.some((entry) => entry.errorCode === 'ADMIN_OUTCOME_UNKNOWN'),
    ).toBe(true);
  });
  it('lists cross-account run metadata and steps without private prompts and cancels queued work safely', async () => {
    const { run, step } = await seedRun();
    const result = await get(
      `/runs?search=${run.id}&state=queued&owner=${staff.id}`,
    ).expect(200);
    expect(result.body as unknown).toMatchObject({
      total: 1,
      items: [{ id: run.id, ownerEmail: staff.email }],
    });
    expect(JSON.stringify(result.body)).not.toContain('PRIVATE PROMPT');
    const steps = await get(`/runs/${run.id}/steps`).expect(200);
    expect(steps.body as unknown).toMatchObject([
      { id: step.id, state: 'queued' },
    ]);
    await post(`/runs/${run.id}/cancel`, {
      reason: 'requested by manager',
    }).expect(200);
    expect((await store.find<Step>('step', step.id))?.state).toBe('cancelled');
    const completed = await seedRun('completed');
    await post(`/runs/${completed.run.id}/cancel`, {
      reason: 'too late to cancel',
    }).expect(409);
  });
  it('updates settings without exposing credentials, overrides the Google domain policy and pauses real queue claims', async () => {
    const response = await get('/settings').expect(200);
    const settings = (response.body as { company: CompanySettings }).company;
    const { run } = await seedRun();
    const body = {
      updatedAt: settings.updatedAt,
      name: 'LCG Media Studio',
      googleAllowedDomains: ['second.example'],
      googleAutoProvision: false,
      queuePaused: true,
      reason: 'maintenance and access policy',
    };
    await patch('/settings', body).expect(200);
    expect((await auth.googleConfiguration()).allowedDomains).toEqual([
      'second.example',
    ]);
    expect(await store.claim()).toBeUndefined();
    await patch('/settings', body).expect(409);
    const current = await store.find<CompanySettings>(
      'company-settings',
      'company',
    );
    await patch('/settings', {
      ...body,
      googleAllowedDomains: ['*.example'],
      updatedAt: current.updatedAt,
    }).expect(400);
    await patch('/settings', {
      ...body,
      queuePaused: false,
      updatedAt: current.updatedAt,
    }).expect(200);
    const claimed = await store.claim();
    expect(claimed).toBeDefined();
    if (claimed) {
      await store.patch<Step>('step', claimed.id, claimed.owner, {
        state: 'cancelled',
      });
      await store.release(claimed);
    }
    await app.get(AgentService).cancel(staff.id, run.id);
    expect(JSON.stringify((await get('/settings')).body)).not.toMatch(
      /MONGODB_URI|GOOGLE_CLIENT_ID|R2_SECRET|passwordHash/,
    );
  });
  it('reports exact aggregate totals, recent activity and fallback storage metadata', async () => {
    await store.insert(
      'asset',
      store.create<Asset>(staff.id, {
        name: 'image.png',
        category: 'Ornament',
        kind: 'source',
        mimeType: 'image/png',
        width: 32,
        height: 32,
        bytes: 1234,
        sha256: 'private-hash',
        revision: 1,
        review: 'draft',
        storageKey: 'mongo:backup-id',
        iv: 'private-iv',
        tag: 'private-tag',
      }),
    );
    const result = await get('/overview').expect(200);
    expect(result.body as unknown).toMatchObject({
      storage: [{ count: 1, bytes: 1234, backups: 1 }],
      queuePaused: false,
    });
    expect(JSON.stringify(result.body)).not.toMatch(
      /private-hash|private-iv|backup-id/,
    );
  });
  it('reads and searches diagnostic metadata while excluding bodies, prompts, images and secrets', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(directory, day);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      path.join(dir, 'events.jsonl'),
      [
        JSON.stringify({
          timestamp: `${day}T12:00:00Z`,
          event: 'http_completed',
          requestId: 'request-admin-failure',
          status: 500,
          path: '/api/image',
          durationMs: 250,
          error: { message: 'Bearer sensitive-token', code: 'STORAGE_ERROR' },
          parts: [{ text: 'PRIVATE PROMPT' }],
          credential: 'PRIVATE GOOGLE TOKEN',
          image: { base64: 'PRIVATE IMAGE' },
        }),
        'not valid json',
        JSON.stringify({
          event: 'http_completed',
          requestId: 'ok-request',
          status: 200,
        }),
      ].join('\n') + '\n',
    );
    const result = await get(
      `/diagnostics?day=${day}&search=request-admin-failure&errorsOnly=true`,
    ).expect(200);
    expect(result.body as unknown).toMatchObject({
      items: [
        {
          requestId: 'request-admin-failure',
          status: 500,
          message: 'Bearer [redacted]',
        },
      ],
      malformed: 1,
    });
    expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE|sensitive-token/);
    await get('/diagnostics?day=..%2F..%2F.env').expect(400);
    await get('/diagnostics?day=2026-02-31').expect(400);
    const first = await get(
      `/diagnostics?day=${day}&search=request-admin-failure&limit=1`,
    ).expect(200);
    const cursor = (first.body as { nextCursor: number }).nextCursor;
    const next = await get(`/diagnostics?day=${day}&cursor=${cursor}`).expect(
      200,
    );
    expect(JSON.stringify(next.body)).not.toContain('request-admin-failure');
  });
});
