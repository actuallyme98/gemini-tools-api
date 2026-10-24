import type { Entity } from './agent.types';

export type PriceRule = {
  provider: 'shopaikey' | 'gemini' | 'vyceai';
  model: string;
  operation: 'text' | 'vision' | 'image' | 'health';
  reserveUsd: number;
  requestUsd?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  imageUsd?: number;
  source: string;
};
export interface BudgetPolicy extends Entity {
  currency?: 'USD' | 'CREDIT';
  defaultWeeklyUsd: number;
  prices: PriceRule[];
}
export type CallUsage = {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  responseId?: string;
};
export type UsageEntry = {
  currency?: 'USD' | 'CREDIT';
  scope?: string;
  id: string;
  requestId: string;
  provider: string;
  model: string;
  operation: PriceRule['operation'];
  reservedMicro: number;
  costMicro?: number;
  basis?: 'reported_usd' | 'configured_rates' | 'manual';
  status: 'submitted' | 'settled' | 'unresolved';
  price: PriceRule;
  usage?: CallUsage;
  createdAt: string;
  settledAt?: string;
};
export type BudgetPeriod = {
  limitMicro: number;
  spentMicro: number;
  reservedMicro: number;
  entries: Record<string, UsageEntry>;
};
export interface BudgetAccount extends Entity {
  overrideUsd: number | null;
  policyVersion: number;
  revision: number;
  periods: Record<string, BudgetPeriod>;
}
export type BudgetSummary = {
  currency: 'USD' | 'CREDIT';
  owner: string;
  periodStart: string;
  periodEnd: string;
  timezone: 'Asia/Bangkok';
  limitUsd: number;
  defaultWeeklyUsd: number;
  overrideUsd: number | null;
  policyVersion: number;
  spentUsd: number;
  reservedUsd: number;
  availableUsd: number;
  usedPercent: number;
};
