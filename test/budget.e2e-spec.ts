import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentStore } from '../src/agent/agent.store';
import { BudgetService } from '../src/agent/budget.service';
import {
  BudgetAdminController,
  UsageController,
} from '../src/agent/budget.controller';
import {
  AgentAuthService,
  AgentGuard,
  AgentAdminGuard,
} from '../src/agent/agent-auth.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { budgetWeek, responseUsage, usageCost } from '../src/agent/budget.util';
import * as budgetUtil from '../src/agent/budget.util';
import type { AgentUser, AdminAudit } from '../src/agent/agent.types';
import type { BudgetAccount, CallUsage } from '../src/agent/budget.types';
import { withRetry } from '../src/utils/function.util';

describe('Weekly employee budgets (real standalone MongoDB)', () => {
  let app: INestApplication, mongo: MongoMemoryServer, directory: string;
  let store: AgentStore,
    budget: BudgetService,
    audit: AuditLogService,
    auth: AgentAuthService;
  let admin: AgentUser,
    employee: AgentUser,
    adminToken: string,
    employeeToken: string;
  const spec = {
    provider: 'shopaikey',
    model: 'test-image',
    operation: 'image' as const,
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const call = (
    task: () => Promise<unknown> = () => Promise.resolve({}),
    usage: () => CallUsage = () => ({ costUsd: 0.25 }),
    scope = randomUUID(),
  ) =>
    audit.run(
      {
        requestId: randomUUID(),
        method: 'TEST',
        path: '/',
        owner: employee.id,
        billingScope: scope,
      },
      () => budget.call(spec, task, usage),
    );
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lcg-budget-'));
    const module = await Test.createTestingModule({
      controllers: [UsageController, BudgetAdminController],
      providers: [
        AgentStore,
        BudgetService,
        AuditLogService,
        AgentAuthService,
        AgentGuard,
        AgentAdminGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            AGENT_ENABLED: true,
            QUEUE_ENABLED: false,
            MONGODB_URI: mongo.getUri(),
            MONGODB_DATABASE: 'budget_test',
            AUDIT_LOG_DIR: directory,
          }),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    store = app.get(AgentStore);
    budget = app.get(BudgetService);
    audit = app.get(AuditLogService);
    auth = app.get(AgentAuthService);
    const created = await auth.createUser(
      'admin@example.com',
      'test-password-at-least12',
      'admin',
    );
    admin = (await store.find<AgentUser>('user', created.id))!;
    adminToken = (
      await auth.login(admin.email, 'test-password-at-least12', randomUUID())
    ).token;
  });
  beforeEach(async () => {
    const created = await auth.createUser(
      randomUUID() + '@example.com',
      'test-password-at-least12',
      'designer',
    );
    employee = (await store.find<AgentUser>('user', created.id))!;
    employeeToken = (
      await auth.login(employee.email, 'test-password-at-least12', randomUUID())
    ).token;
    const policy = await budget.policy();
    await budget.changePolicy(admin, {
      defaultWeeklyUsd: 50,
      prices: [
        {
          ...spec,
          reserveUsd: 1,
          source: 'Verified test price',
          requestUsd: 0.25,
        },
      ],
      updatedAt: policy.updatedAt,
      reason: 'Test policy',
    });
  });
  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it('starts weeks on Monday at midnight UTC+7 and does integer USD calculations', () => {
    expect(budgetWeek(new Date('2026-10-25T16:59:59Z')).key).toBe('2026-10-19');
    expect(budgetWeek(new Date('2026-10-25T17:00:00Z'))).toEqual({
      key: '2026-10-26',
      start: '2026-10-25T17:00:00.000Z',
      end: '2026-11-01T17:00:00.000Z',
    });
    expect(
      usageCost(
        { inputTokens: 1, outputTokens: 1 },
        {
          ...spec,
          reserveUsd: 1,
          inputUsdPerMillion: 0.3,
          outputUsdPerMillion: 1.8,
          source: 'test',
        },
      ),
    ).toEqual({ micro: 3, basis: 'configured_rates' });
    expect(
      usageCost({}, { ...spec, reserveUsd: 1, source: 'unknown' }),
    ).toBeUndefined();
    expect(
      responseUsage(
        {
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 3,
          },
        },
        'genai',
      ),
    ).toMatchObject({ inputTokens: 10, outputTokens: 8 });
    expect(
      responseUsage({ usage: { cost: 10, total_cost: 20 } }, 'openai').costUsd,
    ).toBeUndefined();
  });
  it('gives every account $50, isolates usage and protects every admin endpoint', async () => {
    await request(http()).get('/api/agent/usage').expect(401);
    const mine = await request(http())
      .get('/api/agent/usage')
      .set('Authorization', 'Bearer ' + employeeToken)
      .expect(200);
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(mine.body).toMatchObject({
      owner: employee.id,
      limitUsd: 50,
      availableUsd: 50,
      spentUsd: 0,
      overrideUsd: null,
    });
    for (const url of ['/budget-policy', `/users/${admin.id}/usage`])
      await request(http())
        .get('/api/agent/admin' + url)
        .set('Authorization', 'Bearer ' + employeeToken)
        .expect(403);
    await request(http())
      .patch(`/api/agent/admin/users/${employee.id}/budget`)
      .set('Authorization', 'Bearer ' + employeeToken)
      .send({ weeklyUsd: 100, policyVersion: 0, reason: 'Try bypass' })
      .expect(403);
  });
  it('changes limits immediately, retains costs and detects conflicting admin changes', async () => {
    await call();
    const changed = await budget.changeLimit(admin, employee.id, {
      weeklyUsd: 80,
      policyVersion: 0,
      reason: 'More tasks',
    });
    expect(changed).toMatchObject({
      limitUsd: 80,
      availableUsd: 79.75,
      spentUsd: 0.25,
      policyVersion: 1,
    });
    await expect(
      budget.changeLimit(admin, employee.id, {
        weeklyUsd: 20,
        policyVersion: 0,
        reason: 'Old form',
      }),
    ).rejects.toMatchObject({ response: { code: 'BUDGET_CONFLICT' } });
    await budget.changeLimit(admin, employee.id, {
      weeklyUsd: 0,
      policyVersion: 1,
      reason: 'Temporarily blocked',
    });
    const task = jest.fn();
    await expect(call(task)).rejects.toMatchObject({
      response: { code: 'USER_BUDGET_EXCEEDED' },
    });
    expect(task).not.toHaveBeenCalled();
    expect((await budget.details(employee.id)).spentUsd).toBe(0.25);
    const logs = await store.query<AdminAudit>('admin-audit', {
      action: 'budget.limit_changed',
    });
    expect(
      logs.some(
        (log) =>
          log.outcome === 'success' && log.details.reason === 'More tasks',
      ),
    ).toBe(true);
  });
  it('reserves atomically across concurrent tabs and keeps in-flight charges after a reduction', async () => {
    await budget.changeLimit(admin, employee.id, {
      weeklyUsd: 3,
      policyVersion: 0,
      reason: 'Small test budget',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const pending = Array.from({ length: 20 }, () =>
      call(async () => {
        started++;
        await gate;
        return {};
      }).then(
        () => true,
        () => false,
      ),
    );
    for (let i = 0; i < 200 && started < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(3);
    expect(await budget.details(employee.id)).toMatchObject({
      reservedUsd: 3,
      availableUsd: 0,
    });
    await budget.changeLimit(admin, employee.id, {
      weeklyUsd: 0,
      policyVersion: 1,
      reason: 'Reduce with work running',
    });
    release();
    expect((await Promise.all(pending)).filter(Boolean)).toHaveLength(3);
    expect(await budget.details(employee.id)).toMatchObject({
      spentUsd: 0.75,
      reservedUsd: 0,
      availableUsd: 0,
    });
  });
  it('blocks missing prices before upstream work and never resends an existing paid attempt', async () => {
    const policy = await budget.policy();
    await budget.changePolicy(admin, {
      ...policy,
      prices: [],
      reason: 'No configured prices',
    });
    const task = jest.fn();
    await expect(call(task)).rejects.toMatchObject({
      response: { code: 'BUDGET_PRICING_UNAVAILABLE' },
    });
    expect(task).not.toHaveBeenCalled();
    const current = await budget.policy();
    await budget.changePolicy(admin, {
      ...current,
      prices: [{ ...spec, reserveUsd: 1, requestUsd: 0.2, source: 'verified' }],
      reason: 'Set price',
    });
    const scope = randomUUID();
    await call(undefined, undefined, scope);
    await expect(call(task, undefined, scope)).rejects.toMatchObject({
      response: { code: 'BUDGET_REQUEST_ALREADY_SUBMITTED' },
    });
    expect(task).not.toHaveBeenCalled();
  });
  it('retains unknown and failed charges, reconciles once, and survives a service restart', async () => {
    const policy = await budget.policy();
    await budget.changePolicy(admin, {
      ...policy,
      prices: [{ ...spec, reserveUsd: 1, source: 'Awaiting verified costs' }],
      reason: 'Unknown request pricing',
    });
    await call(undefined, () => ({}));
    await expect(
      call(() => Promise.reject(new Error('upstream timeout'))),
    ).rejects.toMatchObject({
      response: { code: 'BUDGET_REQUEST_UNRESOLVED', retryable: false },
    });
    let details = await budget.details(employee.id);
    expect(details).toMatchObject({ spentUsd: 0, reservedUsd: 2 });
    expect(
      details.entries.every((entry) => entry.status === 'unresolved'),
    ).toBe(true);
    const restarted = new BudgetService(store, audit);
    expect((await restarted.details(employee.id)).reservedUsd).toBe(2);
    const entry = details.entries[0];
    await restarted.reconcile(admin, employee.id, budgetWeek().key, entry.id, {
      costUsd: 0.1,
      reason: 'Checked provider request history',
    });
    await expect(
      restarted.reconcile(admin, employee.id, budgetWeek().key, entry.id, {
        costUsd: 0.1,
        reason: 'Duplicate submission',
      }),
    ).rejects.toMatchObject({ response: { code: 'BUDGET_CONFLICT' } });
    details = await restarted.details(employee.id);
    expect(details).toMatchObject({ spentUsd: 0.1, reservedUsd: 1 });
  });
  it('uses reported USD before configured prices, records overruns, and fails closed without owner', async () => {
    await budget.changeLimit(admin, employee.id, {
      weeklyUsd: 1,
      policyVersion: 0,
      reason: 'One dollar',
    });
    await call(undefined, () => ({ costUsd: 2 }));
    expect(await budget.details(employee.id)).toMatchObject({
      spentUsd: 2,
      reservedUsd: 0,
      availableUsd: 0,
    });
    await expect(call()).rejects.toMatchObject({
      response: { code: 'USER_BUDGET_EXCEEDED' },
    });
    await expect(
      budget.call(
        spec,
        () => Promise.resolve({}),
        () => ({}),
      ),
    ).rejects.toMatchObject({ response: { code: 'BUDGET_CONTEXT_MISSING' } });
  });
  it('never automatically retries an ambiguous upstream request', async () => {
    const task = jest.fn(() => Promise.reject(new Error('connection lost')));
    await expect(
      withRetry(() => call(task), { retries: 3, delayMs: 1 }),
    ).rejects.toMatchObject({
      response: { code: 'BUDGET_REQUEST_UNRESOLVED' },
    });
    expect(task).toHaveBeenCalledTimes(1);
    expect(await budget.details(employee.id)).toMatchObject({
      reservedUsd: 1,
      spentUsd: 0,
    });
  });
  it('keeps worker attempt IDs stable when a cached health check is skipped on restart', async () => {
    const policy = await budget.policy();
    const healthSpec = { ...spec, operation: 'health' as const };
    await budget.changePolicy(admin, {
      ...policy,
      prices: [
        ...policy.prices,
        {
          ...healthSpec,
          reserveUsd: 1,
          requestUsd: 0.01,
          source: 'Verified test health pricing',
        },
      ],
      reason: 'Include paid health checks',
    });
    const scope = randomUUID();
    await audit.run(
      {
        requestId: randomUUID(),
        owner: employee.id,
        billingScope: scope,
        method: 'TEST',
        path: '/',
      },
      async () => {
        await budget.call(
          healthSpec,
          () => Promise.resolve({}),
          () => ({ costUsd: 0.01 }),
        );
        await budget.call(
          spec,
          () => Promise.resolve({}),
          () => ({ costUsd: 0.25 }),
        );
      },
    );
    const task = jest.fn();
    await expect(call(task, undefined, scope)).rejects.toMatchObject({
      response: { code: 'BUDGET_REQUEST_ALREADY_SUBMITTED' },
    });
    expect(task).not.toHaveBeenCalled();
    expect(await budget.details(employee.id)).toMatchObject({ spentUsd: 0.26 });
  });
  it('paginates the admin journal and rejects invalid cursors and weeks', async () => {
    await call();
    const ledger = await store.find<BudgetAccount>(
      'budget-account',
      employee.id,
    );
    const key = budgetWeek().key;
    const period = ledger.periods[key];
    const sample = Object.values(period.entries)[0];
    period.entries = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => {
        const id = index.toString(16).padStart(64, '0');
        return [
          id,
          {
            ...sample,
            id,
            createdAt: new Date(Date.now() + index).toISOString(),
          },
        ];
      }),
    );
    period.spentMicro = 55 * (sample.costMicro ?? 0);
    await store.patch<BudgetAccount>(
      'budget-account',
      employee.id,
      employee.id,
      { periods: ledger.periods },
    );
    const url = `/api/agent/admin/users/${employee.id}/usage`;
    const first = await request(http())
      .get(url)
      .set('Authorization', 'Bearer ' + adminToken)
      .expect(200);
    const firstPage = first.body as {
      entries: { id: string }[];
      nextCursor: number | null;
    };
    expect(first.body).toMatchObject({ totalEntries: 55, nextCursor: 50 });
    expect(firstPage.entries).toHaveLength(50);
    const last = await request(http())
      .get(url + '?cursor=50')
      .set('Authorization', 'Bearer ' + adminToken)
      .expect(200);
    const lastPage = last.body as {
      entries: { id: string }[];
      nextCursor: number | null;
    };
    expect(lastPage.entries).toHaveLength(5);
    expect(lastPage.nextCursor).toBeNull();
    expect(
      new Set(
        [...firstPage.entries, ...lastPage.entries].map(
          (entry: { id: string }) => entry.id,
        ),
      ).size,
    ).toBe(55);
    for (const query of [
      'cursor=-1',
      'cursor=5001',
      'cursor=NaN',
      'period=2026-10-20',
    ])
      await request(http())
        .get(url + '?' + query)
        .set('Authorization', 'Bearer ' + adminToken)
        .expect(400);
  });
  it('settles a previous week and prevents duplicate worker execution after rollover', async () => {
    const scope = randomUUID();
    const original = budgetWeek;
    let now = new Date('2026-10-25T16:59:59Z');
    const clock = jest
      .spyOn(budgetUtil, 'budgetWeek')
      .mockImplementation((date) => original(date ?? now));
    try {
      await call(
        () => {
          now = new Date('2026-10-25T17:00:01Z');
          return Promise.resolve({});
        },
        undefined,
        scope,
      );
      const task = jest.fn();
      await expect(call(task, undefined, scope)).rejects.toMatchObject({
        response: { code: 'BUDGET_REQUEST_ALREADY_SUBMITTED' },
      });
      expect(task).not.toHaveBeenCalled();
      expect(await budget.details(employee.id)).toMatchObject({
        spentUsd: 0,
        availableUsd: 50,
      });
      expect(await budget.details(employee.id, '2026-10-19')).toMatchObject({
        spentUsd: 0.25,
        reservedUsd: 0,
      });
    } finally {
      clock.mockRestore();
    }
  });
  it('changes inherited defaults, preserves overrides, and validates monetary API input', async () => {
    await budget.changeLimit(admin, employee.id, {
      weeklyUsd: 70,
      policyVersion: 0,
      reason: 'Custom weekly amount',
    });
    const policy = await budget.policy();
    await budget.changePolicy(admin, {
      ...policy,
      defaultWeeklyUsd: 25,
      reason: 'Company default',
    });
    expect((await budget.details(employee.id)).limitUsd).toBe(70);
    await budget.changeLimit(admin, employee.id, {
      weeklyUsd: null,
      policyVersion: 1,
      reason: 'Use company default',
    });
    expect((await budget.details(employee.id)).limitUsd).toBe(25);
    for (const weeklyUsd of [-1, 1.234, '100'])
      await request(http())
        .patch(`/api/agent/admin/users/${employee.id}/budget`)
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ weeklyUsd, policyVersion: 2, reason: 'Invalid input' })
        .expect(400);
    const ledger = await store.find<BudgetAccount>(
      'budget-account',
      employee.id,
    );
    const old = {
      ...ledger,
      periods: {
        ...ledger.periods,
        '2026-10-12': {
          limitMicro: 50000000,
          spentMicro: 10000000,
          reservedMicro: 0,
          entries: {},
        },
      },
    };
    await store.patch<BudgetAccount>(
      'budget-account',
      employee.id,
      employee.id,
      old,
    );
    expect(await budget.details(employee.id, '2026-10-12')).toMatchObject({
      limitUsd: 50,
      spentUsd: 10,
    });
    expect((await budget.details(employee.id)).availableUsd).toBe(25);
  });
});
