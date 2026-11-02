import { ConfigService } from '@nestjs/config';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomUUID } from 'node:crypto';
import { AgentStore } from '../src/agent/agent.store';
import { BudgetService } from '../src/agent/budget.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { AgentAuthService } from '../src/agent/agent-auth.service';
import type { AgentUser } from '../src/agent/agent.types';
import type { BudgetAccount } from '../src/agent/budget.types';
import { usageCost, responseUsage } from '../src/agent/budget.util';

describe('Provider credit accounting (isolated MongoDB, no paid requests)', () => {
  let mongo: MongoMemoryServer,
    store: AgentStore,
    budget: BudgetService,
    user: AgentUser;
  const spec = {
    provider: 'shopaikey' as const,
    model: 'gemini-2.5-flash',
    operation: 'text' as const,
  };
  const price = {
    ...spec,
    reserveUsd: 10,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 4,
    source: 'Verified provider credit rates',
  } as const;
  const context = { owner: '', requestId: '', method: 'TEST', path: '/' };
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    const config = new ConfigService({
      AGENT_ENABLED: true,
      QUEUE_ENABLED: false,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DATABASE: 'credit_test',
    });
    store = new AgentStore(config);
    await store.onModuleInit();
    const auth = new AgentAuthService(store, config);
    const created = await auth.createUser(
      'credit@example.com',
      'test-password-for-credit',
      'admin',
    );
    user = (await store.find<AgentUser>('user', created.id))!;
    const audit = {
      currentContext: () => ({
        ...context,
        owner: user.id,
        requestId: randomUUID(),
      }),
      write: () => Promise.resolve(),
    };
    budget = new BudgetService(store, audit as unknown as AuditLogService);
    const policy = await budget.policy();
    await budget.changePolicy(user, {
      defaultWeeklyUsd: 50,
      currency: 'CREDIT',
      prices: [price],
      updatedAt: policy.updatedAt,
      reason: 'Initialize verified credit accounting',
    });
  }, 30000);
  afterAll(async () => {
    await store?.onApplicationShutdown();
    await mongo?.stop();
  });
  it('exposes a 50-credit weekly limit and checks prices without charging or calling AI', async () => {
    expect((await budget.summaries([user.id]))[user.id]).toMatchObject({
      currency: 'CREDIT',
      limitUsd: 50,
      availableUsd: 50,
    });
    expect(await budget.hasPrice(spec)).toBe(true);
    expect(await budget.hasPrice({ ...spec, model: 'unpriced-model' })).toBe(
      false,
    );
    expect(await store.list('budget-account', user.id)).toEqual([]);
  });
  it('uses configured credit rates instead of mixing an explicitly USD-labelled reported cost into credits', async () => {
    expect(
      responseUsage(
        { usage: { input_tokens: 11, output_tokens: 22 } },
        'openai',
        1,
      ),
    ).toMatchObject({ inputTokens: 11, outputTokens: 22, images: 1 });
    const task = jest.fn(() => Promise.resolve({}));
    await budget.call(spec, task, () => ({
      costUsd: 100,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }));
    expect(task).toHaveBeenCalledTimes(1);
    expect((await budget.summaries([user.id]))[user.id]).toMatchObject({
      currency: 'CREDIT',
      spentUsd: 6,
      reservedUsd: 0,
      availableUsd: 44,
    });
    const account = await store.find<BudgetAccount>('budget-account', user.id);
    const entries = Object.values(account.periods).flatMap((period) =>
      Object.values(period.entries),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      currency: 'CREDIT',
      basis: 'configured_rates',
      costMicro: 6_000_000,
    });
    expect(usageCost({ costUsd: 100 }, price, 'CREDIT')).toBeUndefined();
  });
  it('does not silently change an established accounting currency', async () => {
    const policy = await budget.policy();
    await expect(
      budget.changePolicy(user, {
        defaultWeeklyUsd: 50,
        currency: 'USD',
        prices: [price],
        updatedAt: policy.updatedAt,
        reason: 'Should not convert history',
      }),
    ).rejects.toMatchObject({ response: { code: 'BUDGET_CURRENCY_LOCKED' } });
    expect((await budget.policy()).currency).toBe('CREDIT');
  });
  it('keeps missing prices fail-closed and reports the exact model and operation before sending', async () => {
    const task = jest.fn(() => Promise.resolve({}));
    await expect(
      budget.call({ ...spec, model: 'unpriced-model' }, task, () => ({})),
    ).rejects.toMatchObject({
      response: {
        code: 'BUDGET_PRICING_UNAVAILABLE',
        message: expect.stringContaining('unpriced-model (text)') as unknown,
      },
    });
    expect(task).not.toHaveBeenCalled();
  });
  it('keeps budget enforcement and names the correct credit unit', async () => {
    await budget.changeLimit(user, user.id, {
      weeklyUsd: 0,
      policyVersion: 0,
      reason: 'Check exhausted credits',
    });
    const task = jest.fn(() => Promise.resolve({}));
    await expect(budget.call(spec, task, () => ({}))).rejects.toMatchObject({
      response: {
        code: 'USER_BUDGET_EXCEEDED',
        message: expect.stringContaining('0 credit') as unknown,
      },
    });
    expect(task).not.toHaveBeenCalled();
  });
});
