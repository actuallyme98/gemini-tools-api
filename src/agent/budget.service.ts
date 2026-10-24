import { HttpException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AgentStore } from './agent.store';
import { AuditLogService } from '../audit/audit-log.service';
import { ApiError } from '../common/api-error';
import { adminAction } from './admin-audit';
import type { AgentUser } from './agent.types';
import type {
  BudgetAccount,
  BudgetPeriod,
  BudgetPolicy,
  BudgetSummary,
  CallUsage,
  PriceRule,
  UsageEntry,
} from './budget.types';
import { budgetWeek, usageCost, usdMicro } from './budget.util';

@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);
  constructor(
    private readonly store: AgentStore,
    private readonly audit: AuditLogService,
  ) {}
  async policy() {
    await this.store.ensure<BudgetPolicy>('budget-policy', {
      ...this.store.create<BudgetPolicy>('', {
        defaultWeeklyUsd: 50,
        prices: [],
      }),
      id: 'company',
    });
    return await this.store.find<BudgetPolicy>('budget-policy', 'company');
  }
  async hasPrice(spec: Pick<UsageEntry, 'provider' | 'model' | 'operation'>) {
    if (!this.store.enabled) return true;
    return (await this.policy()).prices.some(
      (price) =>
        price.provider === spec.provider &&
        price.model === spec.model &&
        price.operation === spec.operation &&
        price.reserveUsd > 0,
    );
  }
  private async account(owner: string) {
    await this.store.ensure<BudgetAccount>('budget-account', {
      ...this.store.create<BudgetAccount>(owner, {
        overrideUsd: null,
        policyVersion: 0,
        revision: 0,
        periods: {},
      }),
      id: owner,
    });
    return await this.store.find<BudgetAccount>('budget-account', owner);
  }
  private async mutate(
    owner: string,
    change: (account: BudgetAccount, policy: BudgetPolicy) => void,
    admission = false,
  ) {
    await this.account(owner);
    for (let attempt = 0; attempt < 100; attempt++) {
      const [account, policy] = await Promise.all([
        this.store.find<BudgetAccount>('budget-account', owner),
        this.policy(),
      ]);
      const next = structuredClone(account);
      change(next, policy);
      // shortcut: stop admissions at 8MB, leaving space for settlement; archive history before larger journals are needed.
      if (
        Buffer.byteLength(JSON.stringify(next)) >
        (admission ? 8 : 15) * 1024 * 1024
      )
        throw new ApiError(
          503,
          'BUDGET_JOURNAL_FULL',
          'Sổ chi phí cần được lưu trữ trước khi tiếp tục. Liên hệ quản trị viên.',
        );
      const updated = await this.store.patch<BudgetAccount>(
        'budget-account',
        owner,
        owner,
        { ...next, revision: next.revision + 1 },
        { revision: account.revision },
      );
      if (updated) return updated;
    }
    throw new ApiError(
      409,
      'BUDGET_CONFLICT',
      'Ngân sách đang được cập nhật. Vui lòng tải lại.',
    );
  }
  private summary(
    owner: string,
    account: BudgetAccount | undefined,
    policy: BudgetPolicy,
    week = budgetWeek(),
  ): BudgetSummary {
    const current = budgetWeek();
    const period = account?.periods[week.key];
    const limit =
      week.key === current.key
        ? usdMicro(account?.overrideUsd ?? policy.defaultWeeklyUsd)
        : (period?.limitMicro ?? 0);
    const spent = period?.spentMicro ?? 0,
      reserved = period?.reservedMicro ?? 0;
    return {
      currency: policy.currency ?? 'USD',
      owner,
      periodStart: week.start,
      periodEnd: week.end,
      timezone: 'Asia/Bangkok',
      limitUsd: limit / 1e6,
      defaultWeeklyUsd: policy.defaultWeeklyUsd,
      overrideUsd: account?.overrideUsd ?? null,
      policyVersion: account?.policyVersion ?? 0,
      spentUsd: spent / 1e6,
      reservedUsd: reserved / 1e6,
      availableUsd: Math.max(0, limit - spent - reserved) / 1e6,
      usedPercent:
        limit === 0
          ? spent + reserved > 0
            ? 100
            : 0
          : Math.min(100, ((spent + reserved) * 100) / limit),
    };
  }
  async summaries(owners: string[]) {
    if (!owners.length) return {} as Record<string, BudgetSummary>;
    const [policy, accounts] = await Promise.all([
      this.policy(),
      this.store.query<BudgetAccount>(
        'budget-account',
        { id: { $in: owners } },
        owners.length,
      ),
    ]);
    return Object.fromEntries(
      owners.map((owner) => [
        owner,
        this.summary(
          owner,
          accounts.find((account) => account.id === owner),
          policy,
        ),
      ]),
    );
  }
  async details(owner: string, periodKey?: string, cursor = 0) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 5000)
      throw new ApiError(
        400,
        'BUDGET_CURSOR_INVALID',
        'Vị trí trang usage không hợp lệ.',
      );
    if (!(await this.store.find<AgentUser>('user', owner)))
      throw new ApiError(404, 'AGENT_NOT_FOUND', 'Không tìm thấy tài khoản.');
    const [account, policy] = await Promise.all([
      this.account(owner),
      this.policy(),
    ]);
    let week = budgetWeek();
    if (periodKey) {
      const date = new Date(periodKey + 'T00:00:00+07:00');
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(periodKey) ||
        !Number.isFinite(date.getTime()) ||
        budgetWeek(date).key !== periodKey
      )
        throw new ApiError(
          400,
          'BUDGET_PERIOD_INVALID',
          'Ngày bắt đầu tuần không hợp lệ.',
        );
      week = budgetWeek(date);
    }
    const entries = Object.values(
      account.periods[week.key]?.entries ?? {},
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      ...this.summary(owner, account, policy, week),
      periods: Object.keys(account.periods).sort().reverse(),
      totalEntries: entries.length,
      nextCursor: cursor + 50 < entries.length ? cursor + 50 : null,
      entries: entries
        .slice(cursor, cursor + 50)
        .map(({ price, ...entry }) => ({
          ...entry,
          canReconcile:
            entry.status === 'unresolved' ||
            (entry.status === 'submitted' &&
              Date.now() - Date.parse(entry.createdAt) > 30 * 60000),
          reservedUsd: entry.reservedMicro / 1e6,
          costUsd:
            entry.costMicro === undefined ? undefined : entry.costMicro / 1e6,
          priceSource: price.source,
        })),
    };
  }
  async changeLimit(
    actor: AgentUser,
    owner: string,
    input: { weeklyUsd: number | null; policyVersion: number; reason: string },
  ) {
    if (!(await this.store.find<AgentUser>('user', owner)))
      throw new ApiError(404, 'AGENT_NOT_FOUND', 'Không tìm thấy tài khoản.');
    if (input.weeklyUsd !== null) usdMicro(input.weeklyUsd);
    const before = await this.account(owner);
    return adminAction(
      this.store,
      actor,
      'budget.limit_changed',
      owner,
      {
        reason: input.reason,
        beforeUsd: before.overrideUsd,
        afterUsd: input.weeklyUsd,
      },
      async () => {
        await this.mutate(owner, (account, policy) => {
          if (account.policyVersion !== input.policyVersion)
            throw new ApiError(
              409,
              'BUDGET_CONFLICT',
              'Hạn mức đã thay đổi. Tải lại trước khi lưu.',
            );
          account.overrideUsd = input.weeklyUsd;
          account.policyVersion++;
          const period = account.periods[budgetWeek().key];
          if (period)
            period.limitMicro = usdMicro(
              input.weeklyUsd ?? policy.defaultWeeklyUsd,
            );
        });
        return this.details(owner);
      },
    );
  }
  async changePolicy(
    actor: AgentUser,
    input: {
      currency?: 'USD' | 'CREDIT';
      defaultWeeklyUsd: number;
      prices: PriceRule[];
      updatedAt: string;
      reason: string;
    },
  ) {
    usdMicro(input.defaultWeeklyUsd);
    const before = await this.policy();
    const currency = input.currency ?? before.currency ?? 'USD';
    if (currency !== (before.currency ?? 'USD')) {
      if (before.currency !== undefined || before.prices.length)
        throw new ApiError(
          409,
          'BUDGET_CURRENCY_LOCKED',
          'Chỉ được chọn đơn vị khi thiết lập bảng giá lần đầu, trước khi có usage.',
        );
      const accounts = await this.store.query<BudgetAccount>(
        'budget-account',
        {},
        1001,
      );
      if (
        accounts.length > 1000 ||
        accounts.some((account) =>
          Object.values(account.periods).some(
            (period) =>
              Object.keys(period.entries).length ||
              period.spentMicro ||
              period.reservedMicro,
          ),
        )
      )
        throw new ApiError(
          409,
          'BUDGET_CURRENCY_LOCKED',
          'Không thể đổi đơn vị khi đã có sổ usage. Cần đối soát và chuyển đổi dữ liệu trước.',
        );
    }
    return adminAction(
      this.store,
      actor,
      'budget.policy_changed',
      'company',
      {
        reason: input.reason,
        beforeUsd: before.defaultWeeklyUsd,
        afterUsd: input.defaultWeeklyUsd,
        beforePrices: before.prices,
        afterPrices: input.prices,
        beforeCurrency: before.currency ?? 'USD',
        afterCurrency: currency,
      },
      async () => {
        const updated = await this.store.patch<BudgetPolicy>(
          'budget-policy',
          'company',
          '',
          {
            defaultWeeklyUsd: input.defaultWeeklyUsd,
            prices: input.prices,
            currency,
          },
          { updatedAt: input.updatedAt },
        );
        if (!updated)
          throw new ApiError(
            409,
            'BUDGET_CONFLICT',
            'Bảng giá hoặc ngân sách mặc định đã thay đổi. Tải lại trước khi lưu.',
          );
        return updated;
      },
    );
  }
  async reconcile(
    actor: AgentUser,
    owner: string,
    key: string,
    entryId: string,
    input: { costUsd: number; reason: string },
  ) {
    const micro = usdMicro(input.costUsd);
    return adminAction(
      this.store,
      actor,
      'budget.cost_reconciled',
      owner,
      { reason: input.reason, period: key, entryId, costUsd: input.costUsd },
      async () => {
        await this.settle(
          owner,
          key,
          entryId,
          { micro, basis: 'manual' },
          undefined,
          true,
        );
        return this.details(owner, key);
      },
    );
  }
  private async reserve(
    owner: string,
    id: string,
    requestId: string,
    spec: Pick<UsageEntry, 'provider' | 'model' | 'operation'>,
    scope?: string,
  ) {
    const user = await this.store.find<AgentUser>('user', owner);
    if (!user || user.disabled)
      throw new ApiError(
        403,
        'AGENT_ACCOUNT_DISABLED',
        'Tài khoản không còn quyền gửi yêu cầu AI.',
      );
    const week = budgetWeek();
    let selected!: PriceRule;
    let currency: 'USD' | 'CREDIT' = 'USD';
    await this.mutate(
      owner,
      (account, policy) => {
        currency = policy.currency ?? 'USD';
        if (Object.values(account.periods).some((period) => period.entries[id]))
          throw new ApiError(
            409,
            'BUDGET_REQUEST_ALREADY_SUBMITTED',
            'Lượt AI này đã được gửi hoặc đang chờ đối soát. Hệ thống không tự gửi lại.',
          );
        const limitMicro = usdMicro(
          account.overrideUsd ?? policy.defaultWeeklyUsd,
        );
        const period: BudgetPeriod = (account.periods[week.key] ??= {
          limitMicro,
          spentMicro: 0,
          reservedMicro: 0,
          entries: {},
        });
        period.limitMicro = limitMicro;
        if (limitMicro <= period.spentMicro + period.reservedMicro)
          throw new ApiError(
            403,
            'USER_BUDGET_EXCEEDED',
            `Đã hết ngân sách AI tuần này. Hạn mức ${limitMicro / 1e6} ${currency === 'CREDIT' ? 'credit' : 'USD'}; cấp lại ${week.end}. Liên hệ quản trị viên để tăng hạn mức.`,
          );
        selected = policy.prices.find(
          (price) =>
            price.provider === spec.provider &&
            price.model === spec.model &&
            price.operation === spec.operation,
        )!;
        if (!selected)
          throw new ApiError(
            503,
            'BUDGET_PRICING_UNAVAILABLE',
            `Chưa có bảng giá cho model ${spec.model} (${spec.operation}). Nhờ quản trị viên cấu hình trước khi gửi AI.`,
            { provider: spec.provider, retryable: false },
          );
        const held = usdMicro(selected.reserveUsd);
        if (
          held <= 0 ||
          held + period.spentMicro + period.reservedMicro > limitMicro
        )
          throw new ApiError(
            403,
            'USER_BUDGET_EXCEEDED',
            `Ngân sách khả dụng ${Math.max(0, limitMicro - period.spentMicro - period.reservedMicro) / 1e6} ${currency === 'CREDIT' ? 'credit' : 'USD'}, cần giữ chỗ ${held / 1e6} ${currency === 'CREDIT' ? 'credit' : 'USD'}. Liên hệ quản trị viên để tăng hạn mức.`,
          );
        if (Object.keys(period.entries).length >= 5000)
          throw new ApiError(
            503,
            'BUDGET_JOURNAL_FULL',
            'Sổ chi phí tuần đã đạt giới hạn. Liên hệ quản trị viên.',
          );
        period.entries[id] = {
          currency,
          ...spec,
          ...(scope ? { scope } : {}),
          id,
          requestId,
          reservedMicro: held,
          status: 'submitted',
          price: selected,
          createdAt: new Date().toISOString(),
        };
        period.reservedMicro += held;
      },
      true,
    );
    return { key: week.key, price: selected, currency };
  }
  private async settle(
    owner: string,
    key: string,
    id: string,
    cost?: { micro: number; basis: UsageEntry['basis'] },
    usage?: CallUsage,
    manual = false,
  ) {
    return this.mutate(owner, (account) => {
      const period = account.periods[key],
        entry = period?.entries[id];
      if (!entry)
        throw new ApiError(
          409,
          'BUDGET_ENTRY_MISSING',
          'Không tìm thấy khoản giữ chỗ.',
        );
      if (entry.status === 'settled') {
        if (manual)
          throw new ApiError(
            409,
            'BUDGET_CONFLICT',
            'Khoản phí này đã được chốt; không trừ tiền lần hai.',
          );
        return;
      }
      if (
        manual &&
        entry.status !== 'unresolved' &&
        Date.now() - Date.parse(entry.createdAt) <= 30 * 60000
      )
        throw new ApiError(
          409,
          'BUDGET_REQUEST_PENDING',
          'Request còn đang chạy; chỉ đối soát khi kết quả chi phí chưa xác định.',
        );
      entry.usage = usage ?? entry.usage;
      if (!cost) {
        entry.status = 'unresolved';
        return;
      }
      period.reservedMicro -= entry.reservedMicro;
      period.spentMicro += cost.micro;
      entry.status = 'settled';
      entry.costMicro = cost.micro;
      entry.basis = cost.basis;
      entry.settledAt = new Date().toISOString();
    });
  }
  async call<T>(
    spec: Pick<UsageEntry, 'provider' | 'model' | 'operation'>,
    task: () => Promise<T>,
    usage: (response: T) => CallUsage,
  ): Promise<T> {
    if (!this.store.enabled) return task();
    const context = this.audit.currentContext();
    if (!context?.owner)
      throw new ApiError(
        503,
        'BUDGET_CONTEXT_MISSING',
        'Thiếu tài khoản xác thực cho request AI.',
      );
    const calls = (context.billingCalls ??= {});
    const callKey = JSON.stringify([spec.provider, spec.model, spec.operation]);
    const sequence = (calls[callKey] = (calls[callKey] ?? 0) + 1);
    const id = createHash('sha256')
      .update(
        `${context.owner}:${context.billingScope ?? context.requestId}:${sequence}:${spec.provider}:${spec.model}:${spec.operation}`,
      )
      .digest('hex');
    const reservation = await this.reserve(
      context.owner,
      id,
      context.requestId,
      spec,
      context.billingScope,
    );
    let result: T;
    try {
      result = await task();
    } catch (error) {
      await this.settle(context.owner, reservation.key, id).catch(() =>
        this.logger.error(
          'AI reservation remains submitted; reconciliation required.',
        ),
      );
      const status =
        error instanceof HttpException
          ? error.getStatus()
          : Number((error as { status?: unknown } | null)?.status);
      if (status >= 400 && status < 500 && status !== 408) throw error;
      throw new ApiError(
        503,
        'BUDGET_REQUEST_UNRESOLVED',
        'Request AI bị gián đoạn, chưa xác định được chi phí. Ngân sách đang được giữ để đối soát; hệ thống không tự gửi lại hoặc chuyển model để tránh tính phí trùng.',
        { provider: spec.provider, retryable: false, cause: error },
      );
    }
    // Once an upstream request succeeds, a ledger failure must never trigger paid retry/fallback.
    try {
      const report = usage(result);
      await this.settle(
        context.owner,
        reservation.key,
        id,
        usageCost(report, reservation.price, reservation.currency),
        report,
      );
    } catch {
      this.logger.error(
        'AI response returned; its held cost needs reconciliation.',
      );
      await this.settle(context.owner, reservation.key, id).catch(
        () => undefined,
      );
    }
    return result;
  }
}
