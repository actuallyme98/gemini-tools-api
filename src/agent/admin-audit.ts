import { ApiError } from '../common/api-error';
import type { AgentStore } from './agent.store';
import type { AdminAudit, AgentUser } from './agent.types';
import { sanitizeErrorMessage } from '../common/error-sanitizer';

function safeDetails(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeErrorMessage(value, 1000);
  if (Array.isArray(value)) return value.map(safeDetails);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        /password|token|secret|credential|key/i.test(key)
          ? '[redacted]'
          : safeDetails(field),
      ]),
    );
  return value;
}

export async function adminAction<T>(
  store: AgentStore,
  actor: AgentUser,
  action: string,
  target: string,
  details: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  if (actor.role !== 'admin' || actor.disabled)
    throw new ApiError(
      403,
      'AGENT_ADMIN_REQUIRED',
      'Chỉ quản trị viên được thực hiện thao tác này.',
    );
  // Record intent before changing data; an interrupted action remains visible as pending.
  const entry = await store.insert(
    'admin-audit',
    store.create<AdminAudit>(actor.id, {
      actorEmail: actor.email,
      action,
      target,
      details: safeDetails(details) as Record<string, unknown>,
      outcome: 'pending',
    }),
  );
  let result: T;
  try {
    result = await work();
  } catch (error) {
    const body: unknown =
      error instanceof ApiError ? error.getResponse() : undefined;
    const code =
      body &&
      typeof body === 'object' &&
      'code' in body &&
      typeof body.code === 'string'
        ? body.code
        : 'ADMIN_OUTCOME_UNKNOWN';
    await store.patch<AdminAudit>('admin-audit', entry.id, actor.id, {
      outcome: error instanceof ApiError ? 'failed' : 'pending',
      errorCode: code,
    });
    throw error;
  }
  await store.patch<AdminAudit>('admin-audit', entry.id, actor.id, {
    outcome: 'success',
  });
  return result;
}
