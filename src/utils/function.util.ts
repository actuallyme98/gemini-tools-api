export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    retries?: number;
    delayMs?: number;
    onRetry?: (error: unknown, attempt: number) => void;
  },
): Promise<T> {
  const retries = options?.retries ?? 5;
  const delayMs = options?.delayMs ?? 1000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      options?.onRetry?.(err, attempt);

      if (attempt < retries) {
        const wait = delayMs * Math.pow(2, attempt - 1);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  }

  throw lastError;
}
