import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import request from 'supertest';
import { AgentStore } from '../src/agent/agent.store';
import {
  AgentAuthService,
  AgentGuard,
  AgentAdminGuard,
} from '../src/agent/agent-auth.service';
import { BudgetService } from '../src/agent/budget.service';
import {
  budgetDay,
  type TeamBudgetAccount,
} from '../src/agent/team-budget.types';
import {
  AuditLogService,
  type AuditContext,
} from '../src/audit/audit-log.service';
import { StudioGuard } from '../src/studio/studio.controller';
import { StudioService } from '../src/studio/studio.service';
import { StudioOperationsService } from '../src/studio/studio-operations.service';
import {
  StudioOperationsController,
  StudioTeamBudgetsController,
} from '../src/studio/studio-operations.controller';
import { AgentAssetsService } from '../src/agent/agent-assets.service';
import { AIService } from '../src/ai/ai.service';
import { ApiError } from '../src/common/api-error';
import { isBudgetError } from '../src/agent/budget.util';
import type { AgentUser } from '../src/agent/agent.types';
import type { BudgetAccount } from '../src/agent/budget.types';
import type { StudioTeam } from '../src/studio/studio.types';

describe('Team daily budgets (real isolated MongoDB, zero provider requests)', () => {
  let mongo: MongoMemoryServer,
    app: INestApplication,
    store: AgentStore,
    budget: BudgetService,
    admin: AgentUser,
    seller: AgentUser,
    other: AgentUser,
    leader: AgentUser;
  const context = new AsyncLocalStorage<AuditContext>();
  const audit = {
    run: <T>(data: AuditContext, callback: () => T) =>
      context.run(data, callback),
    currentContext: () => context.getStore(),
    write: jest.fn().mockResolvedValue(undefined),
  };
  const tokens = new Map<string, string>();
  const spec = {
    provider: 'shopaikey',
    model: 'test-image',
    operation: 'image' as const,
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const config = new ConfigService({
      AGENT_ENABLED: true,
      STUDIO_ENABLED: true,
      QUEUE_ENABLED: false,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DATABASE: 'team_daily_test',
    });
    const module = await Test.createTestingModule({
      controllers: [StudioTeamBudgetsController, StudioOperationsController],
      providers: [
        AgentStore,
        AgentAuthService,
        AgentGuard,
        AgentAdminGuard,
        StudioGuard,
        StudioService,
        StudioOperationsService,
        BudgetService,
        { provide: ConfigService, useValue: config },
        { provide: AuditLogService, useValue: audit },
        { provide: AgentAssetsService, useValue: {} },
        { provide: AIService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    store = app.get(AgentStore);
    budget = app.get(BudgetService);
    const auth = app.get(AgentAuthService);
    const users: AgentUser[] = [];
    for (const [name, role] of [
      ['admin', 'admin'],
      ['seller', 'designer'],
      ['other', 'designer'],
      ['leader', 'designer'],
    ] as const) {
      const user = await auth.createUser(
        `${name}@test.example`,
        'team-budget-test-password',
        role,
      );
      users.push(await store.find<AgentUser>('user', user.id));
      tokens.set(
        user.id,
        (
          await auth.login(
            user.email,
            'team-budget-test-password',
            randomUUID(),
          )
        ).token,
      );
    }
    [admin, seller, other, leader] = users;
    const policy = await budget.policy();
    await budget.changePolicy(admin, {
      defaultWeeklyUsd: 50,
      currency: 'CREDIT',
      prices: [
        {
          ...spec,
          provider: 'shopaikey',
          reserveUsd: 1,
          imageUsd: 0.5,
          source: 'fixed test credit rate',
        },
      ],
      updatedAt: policy.updatedAt,
      reason: 'Isolated credit policy',
    });
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });
  async function team(limit: number | null) {
    const record = await app.get(StudioService).saveTeam(admin, undefined, {
      name: 'Budget team',
      members: [
        { userId: seller.id, role: 'seller' },
        { userId: other.id, role: 'seller' },
        { userId: leader.id, role: 'leader' },
      ],
      archived: false,
    });
    await budget.changeTeamLimit(admin, record.id, {
      dailyLimit: limit,
      policyVersion: 0,
      reason: 'Configure test daily cap',
    });
    return record;
  }
  function call<T>(
    record: StudioTeam,
    owner: AgentUser,
    task: () => Promise<T>,
    scope = randomUUID(),
  ) {
    return audit.run(
      {
        owner: owner.id,
        requestId: randomUUID(),
        method: 'TEST',
        path: '/studio',
        billingTeamId: record.id,
        billingScope: scope,
      },
      () => budget.call(spec, task, () => ({ images: 1 })),
    );
  }
  it('uses UTC+7 midnight and grants admin edit / Leader read without exposing company finance to employees', async () => {
    expect(budgetDay(new Date('2026-10-28T16:59:59Z')).key).toBe('2026-10-28');
    expect(budgetDay(new Date('2026-10-28T17:00:00Z')).key).toBe('2026-10-29');
    const record = await team(10);
    await request(http())
      .get(`/api/agent/studio/team-budgets/${record.id}`)
      .expect(401);
    await request(http())
      .get(`/api/agent/studio/team-budgets/${record.id}`)
      .set('Authorization', `Bearer ${tokens.get(seller.id)}`)
      .expect(404);
    const response = await request(http())
      .get(`/api/agent/studio/team-budgets/${record.id}`)
      .set('Authorization', `Bearer ${tokens.get(leader.id)}`)
      .expect(200);
    expect(response.body as unknown).toMatchObject({
      currency: 'CREDIT',
      dailyLimit: 10,
      reserved: 0,
    });
    await request(http())
      .patch(`/api/agent/studio/team-budgets/${record.id}`)
      .set('Authorization', `Bearer ${tokens.get(leader.id)}`)
      .send({ dailyLimit: 50, policyVersion: 1, reason: 'Not allowed' })
      .expect(403);
    await request(http())
      .get(`/api/agent/studio/team-budgets/${record.id}/entries`)
      .set('Authorization', `Bearer ${tokens.get(leader.id)}`)
      .expect(403);
    await request(http())
      .get('/api/agent/studio/operations/batches')
      .set('Authorization', `Bearer ${tokens.get(seller.id)}`)
      .expect(403);
    await request(http())
      .get(`/api/agent/studio/team-budgets/${record.id}?day=2026-02-31`)
      .set('Authorization', `Bearer ${tokens.get(admin.id)}`)
      .expect(400);
  });
  it('admits only one employee against the Team final credit under concurrent requests', async () => {
    const record = await team(1);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = jest.fn(async () => {
      entered();
      await gate;
      return 'ok';
    });
    const running = call(record, seller, upstream);
    await started;
    const blocked = jest.fn().mockResolvedValue('not called');
    await expect(call(record, other, blocked)).rejects.toThrow();
    expect(blocked).not.toHaveBeenCalled();
    expect(await budget.teamSummary(record.id)).toMatchObject({
      reserved: 1,
      spent: 0,
      available: 0,
    });
    expect((await budget.summaries([other.id]))[other.id].reservedUsd).toBe(0);
    release();
    await running;
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await budget.teamSummary(record.id)).toMatchObject({
      spent: 0.5,
      reserved: 0,
      available: 0.5,
    });
  });
  it('retains unresolved provider calls in both ledgers and reconciles exactly once', async () => {
    const record = await team(2);
    await expect(
      call(record, seller, () =>
        Promise.reject(new Error('unknown network outcome')),
      ),
    ).rejects.toThrow();
    const entries = await budget.teamEntries(record.id, budgetDay().key, 1);
    expect(entries.summary).toMatchObject({ reserved: 1, spent: 0 });
    expect(entries.items[0].status).toBe('unresolved');
    const held = entries.items[0];
    await budget.reconcile(admin, seller.id, held.personalPeriod, held.id, {
      costUsd: 0.25,
      reason: 'Provider verified cost',
    });
    await budget.repairTeamBudget(record.id);
    await budget.repairTeamBudget(record.id);
    expect(await budget.teamSummary(record.id)).toMatchObject({
      reserved: 0,
      spent: 0.25,
    });
    await expect(
      budget.reconcile(admin, seller.id, held.personalPeriod, held.id, {
        costUsd: 0.25,
        reason: 'Must not double charge',
      }),
    ).rejects.toThrow();
  });
  it('repairs a lost Team settlement after the personal ledger committed without repeating AI', async () => {
    const record = await team(5);
    const originalPatch = store.patch.bind(store) as AgentStore['patch'];
    let failed = false;
    const spy = jest
      .spyOn(store, 'patch')
      .mockImplementation(async (kind, ...args) => {
        if (
          kind === 'team-budget' &&
          !failed &&
          (args[2] as Partial<TeamBudgetAccount>).periods &&
          Object.values((args[2] as TeamBudgetAccount).periods).some(
            (period) => period.spentMicro > 0,
          )
        ) {
          failed = true;
          throw new Error('simulated mirror write failure');
        }
        return originalPatch(kind, ...args);
      });
    const upstream = jest.fn().mockResolvedValue('ok');
    try {
      await call(record, other, upstream);
    } finally {
      spy.mockRestore();
    }
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(failed).toBe(true);
    const mirror = await store.find<TeamBudgetAccount>(
      'team-budget',
      record.id,
    );
    const period = mirror.periods[budgetDay().key];
    const originalEntries = period.entries;
    period.entries = {};
    for (let index = 0; index < 201; index++) {
      const id = `unresolved-${index}`;
      period.entries[id] = {
        id,
        owner: other.id,
        personalPeriod: 'missing',
        requestId: id,
        reservedMicro: 0,
        status: 'unresolved',
        createdAt: new Date().toISOString(),
      };
    }
    Object.assign(period.entries, originalEntries);
    await store.patch<TeamBudgetAccount>('team-budget', record.id, record.id, {
      periods: mirror.periods,
    });
    await budget.repairTeamBudget(record.id);
    expect(await budget.teamSummary(record.id)).toMatchObject({
      spent: 0.5,
      reserved: 0,
    });
  });
  it('changes limits with a version guard; zero blocks and null removes only the Team cap', async () => {
    const record = await team(0),
      upstream = jest.fn().mockResolvedValue('ok');
    await expect(call(record, seller, upstream)).rejects.toThrow();
    expect(upstream).not.toHaveBeenCalled();
    const original = await budget.teamSummary(record.id);
    const results = await Promise.allSettled(
      [1, 2].map((dailyLimit) =>
        budget.changeTeamLimit(admin, record.id, {
          dailyLimit,
          policyVersion: original.policyVersion,
          reason: 'Concurrent edit',
        }),
      ),
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const updated = await budget.teamSummary(record.id);
    await budget.changeTeamLimit(admin, record.id, {
      dailyLimit: null,
      policyVersion: updated.policyVersion,
      reason: 'Uncap test Team',
    });
    await budget.changeLimit(admin, seller.id, {
      weeklyUsd: 0,
      policyVersion: (await budget.details(seller.id)).policyVersion,
      reason: 'Keep individual cap enforced',
    });
    await expect(call(record, seller, upstream)).rejects.toThrow();
    expect(upstream).not.toHaveBeenCalled();
    const personal = await budget.details(seller.id);
    await budget.changeLimit(admin, seller.id, {
      weeklyUsd: null,
      policyVersion: personal.policyVersion,
      reason: 'Restore individual limit',
    });
    expect(
      isBudgetError(new ApiError(403, 'TEAM_BUDGET_EXCEEDED', 'Team cap')),
    ).toBe(true);
  });
  it('does not count prior-day holds against today and rejects disabled membership before upstream', async () => {
    const record = await team(1);
    const account = await store.find<TeamBudgetAccount>(
      'team-budget',
      record.id,
    );
    const yesterday = budgetDay(new Date(Date.now() - 86400000)).key;
    account.periods[yesterday] = {
      limitMicro: 1000000,
      reservedMicro: 1000000,
      spentMicro: 0,
      entries: {},
    };
    await store.patch<TeamBudgetAccount>('team-budget', record.id, record.id, {
      periods: account.periods,
    });
    const upstream = jest.fn().mockResolvedValue('ok');
    await call(record, seller, upstream);
    expect(await budget.teamSummary(record.id)).toMatchObject({
      spent: 0.5,
      reserved: 0,
    });
    await store.patch<StudioTeam>('studio-team', record.id, admin.id, {
      memberIds: [leader.id],
      members: [{ userId: leader.id, role: 'leader' }],
    });
    await expect(call(record, seller, upstream)).rejects.toThrow();
    expect(upstream).toHaveBeenCalledTimes(1);
    const personal = await store.find<BudgetAccount>(
      'budget-account',
      seller.id,
    );
    expect(
      Object.values(personal.periods)
        .flatMap((period) => Object.values(period.entries))
        .filter((entry) => entry.team?.id === record.id)
        .every((entry) => entry.status === 'settled'),
    ).toBe(true);
  });
});
