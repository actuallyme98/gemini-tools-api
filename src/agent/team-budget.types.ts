import type { Entity } from './agent.types';

export type TeamHold = {
  id: string;
  owner: string;
  personalPeriod: string;
  requestId: string;
  scope?: string;
  reservedMicro: number;
  costMicro?: number;
  status: 'held' | 'unresolved' | 'settled';
  createdAt: string;
};
export interface TeamBudgetAccount extends Entity {
  currency: 'USD' | 'CREDIT';
  dailyLimitMicro: number | null;
  policyVersion: number;
  revision: number;
  periods: Record<
    string,
    {
      limitMicro: number | null;
      spentMicro: number;
      reservedMicro: number;
      entries: Record<string, TeamHold>;
    }
  >;
}
export function budgetDay(now = new Date()) {
  const key = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  const start = new Date(`${key}T00:00:00+07:00`);
  return {
    key,
    start: start.toISOString(),
    end: new Date(start.getTime() + 86400000).toISOString(),
  };
}
