import { setTimeout } from 'node:timers/promises';
import { ApiError } from '../common/api-error';
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    retries?: number;
    delayMs?: number;
    onRetry?: (error: unknown, attempt: number) => void;
    signal?: AbortSignal;
  },
): Promise<T> {
  const retries = options?.retries ?? 5;
  const delayMs = options?.delayMs ?? 1000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    options?.signal?.throwIfAborted();
    try {
      const result = await fn();
      options?.signal?.throwIfAborted();
      return result;
    } catch (err: unknown) {
      options?.signal?.throwIfAborted();
      lastError = err;
      if (err instanceof ApiError && !err.retryable) throw err;
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? Number(err.status)
          : undefined;
      if (
        status &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
      )
        throw err;
      options?.onRetry?.(err, attempt);
      if (attempt < retries)
        await setTimeout(delayMs * Math.pow(2, attempt - 1), undefined, {
          signal: options?.signal,
        });
    }
  }
  throw lastError;
}
