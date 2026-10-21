import { BackgroundJobsService } from './background-jobs.service';
import { ApiError } from '../common/api-error';

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('Background image jobs', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps a single task alive beyond proxy timeouts, returns its trace, then expires it', async () => {
    const jobs = new BackgroundJobsService();
    let finish!: (value: { url: string; mimeType: string }) => void;
    const work = jest.fn(
      () =>
        new Promise<{ url: string; mimeType: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const started = jobs.create(work, 'original-request');
    await tick();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 150000);
    expect(jobs.get(started.jobId).state).toBe('pending');
    expect(work).toHaveBeenCalledTimes(1);
    finish({ url: 'https://cdn.example/result.png', mimeType: 'image/png' });
    await tick();
    expect(jobs.get(started.jobId)).toMatchObject({
      state: 'done',
      result: {
        requestId: 'original-request',
        url: 'https://cdn.example/result.png',
      },
    });
    expect(work).toHaveBeenCalledTimes(1);
    jest.spyOn(Date, 'now').mockReturnValue(now + 150000 + 3600001);
    expect(() => jobs.get(started.jobId)).toThrow(ApiError);
  });

  it('preserves useful AI errors and redacts credentials', async () => {
    const jobs = new BackgroundJobsService();
    const job = jobs.create(
      () =>
        Promise.reject(
          new ApiError(429, 'AI_RATE_LIMITED', 'Slow down sk-secret123456789', {
            retryable: true,
            upstreamStatus: 429,
          }),
        ),
      'trace-error',
    );
    await tick();
    await tick();
    expect(jobs.get(job.jobId)).toMatchObject({
      state: 'failed',
      error: {
        statusCode: 429,
        code: 'AI_RATE_LIMITED',
        requestId: 'trace-error',
        upstreamStatus: 429,
        retryable: true,
      },
    });
    expect(JSON.stringify(jobs.get(job.jobId))).not.toContain('sk-secret');
  });

  it('bounds concurrent paid tasks and accepts work again after completion', async () => {
    const jobs = new BackgroundJobsService();
    let finish!: (value: { url: string; mimeType: string }) => void;
    jobs.create(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      'first',
    );
    for (let i = 1; i < 6; i++)
      jobs.create(() => new Promise(() => {}), String(i));
    expect(() =>
      jobs.create(() => Promise.resolve({ url: '', mimeType: '' }), 'overflow'),
    ).toThrow(ApiError);
    await tick();
    finish({ url: 'done', mimeType: 'image/png' });
    await tick();
    expect(() =>
      jobs.create(() => Promise.resolve({ url: '', mimeType: '' }), 'next'),
    ).not.toThrow();
  });
});
