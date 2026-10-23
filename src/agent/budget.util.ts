import { ApiError } from '../common/api-error';
import type { CallUsage, PriceRule } from './budget.types';

export function usdMicro(value: number): number {
  const micro = Math.round(value * 1_000_000);
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(micro) ||
    micro > 1_000_000_000_000
  )
    throw new ApiError(
      400,
      'BUDGET_AMOUNT_INVALID',
      'Số tiền USD không hợp lệ.',
    );
  return micro;
}
export function budgetWeek(now = new Date()) {
  const local = new Date(now.getTime() + 7 * 3600000);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  const start = new Date(local.getTime() - 7 * 3600000);
  return {
    key: local.toISOString().slice(0, 10),
    start: start.toISOString(),
    end: new Date(start.getTime() + 7 * 86400000).toISOString(),
  };
}
export function usageCost(
  usage: CallUsage,
  price: PriceRule,
): { micro: number; basis: 'reported_usd' | 'configured_rates' } | undefined {
  if (usage.costUsd !== undefined)
    return { micro: usdMicro(usage.costUsd), basis: 'reported_usd' };
  let micro =
    price.requestUsd === undefined
      ? undefined
      : BigInt(usdMicro(price.requestUsd));
  for (const [count, rate] of [
    [usage.inputTokens, price.inputUsdPerMillion],
    [usage.outputTokens, price.outputUsdPerMillion],
  ] as const) {
    if (rate !== undefined) {
      if (!Number.isSafeInteger(count) || count < 0) return;
      micro =
        (micro ?? 0n) +
        (BigInt(count) * BigInt(usdMicro(rate)) + 999999n) / 1000000n;
    }
  }
  if (price.imageUsd !== undefined) {
    if (!Number.isSafeInteger(usage.images) || usage.images < 0) return;
    micro =
      (micro ?? 0n) + BigInt(usage.images) * BigInt(usdMicro(price.imageUsd));
  }
  if (micro === undefined) return;
  const amount = Number(micro);
  if (!Number.isSafeInteger(amount) || amount > 1_000_000_000_000)
    throw new Error('Cost exceeds supported range');
  return { micro: amount, basis: 'configured_rates' };
}
export function isBudgetError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const body = error.getResponse() as { code?: string };
  return (
    !!body.code &&
    (body.code.startsWith('BUDGET_') || body.code === 'USER_BUDGET_EXCEEDED')
  );
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
export function responseUsage(
  value: unknown,
  kind: 'genai' | 'openai',
  images?: number,
): CallUsage {
  const response = object(value),
    usage = object(kind === 'genai' ? response.usageMetadata : response.usage);
  const output = number(usage.candidatesTokenCount);
  const thoughts = number(usage.thoughtsTokenCount);
  const responseId = response.responseId ?? response.id;
  return {
    // Only an explicitly USD-labelled field is accepted as a monetary amount.
    costUsd: number(usage.cost_usd ?? response.cost_usd),
    inputTokens: number(
      kind === 'genai' ? usage.promptTokenCount : usage.prompt_tokens,
    ),
    outputTokens:
      kind === 'genai'
        ? output === undefined
          ? undefined
          : output + (thoughts ?? 0)
        : number(usage.completion_tokens),
    images,
    responseId:
      typeof responseId === 'string' ? responseId.slice(0, 200) : undefined,
  };
}
