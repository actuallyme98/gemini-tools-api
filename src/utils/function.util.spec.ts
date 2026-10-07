import { withRetry } from './function.util';
describe('Paid request retry boundaries', () => {
  it('does not call a provider when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const call = jest.fn();
    await expect(
      withRetry(call, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
  it('does not retry authentication errors', async () => {
    const call = jest.fn().mockRejectedValue({ status: 401 });
    await expect(withRetry(call)).rejects.toEqual({ status: 401 });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('retries transient rate limits', async () => {
    const call = jest
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue('ok');
    expect(await withRetry(call, { delayMs: 1 })).toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });
});
