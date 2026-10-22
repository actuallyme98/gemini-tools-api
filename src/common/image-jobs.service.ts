import { HttpException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError } from './api-error';
import { sanitizeErrorMessage } from './error-sanitizer';
import { AuditLogService } from '../audit/audit-log.service';

type ImageResult = { url: string; mimeType: string; requestId: string };
type Job = {
  jobId: string;
  requestId: string;
  state: 'pending' | 'done' | 'failed';
  expiresAt: number;
  result?: ImageResult;
  error?: Record<string, unknown>;
};

@Injectable()
export class ImageJobsService {
  // shortcut: Jobs live in one API process; use a durable queue before scaling or restart recovery.
  private readonly jobs = new Map<string, Job>();
  constructor(@Optional() private readonly audit?: AuditLogService) {}

  create(
    work: () => Promise<Omit<ImageResult, 'requestId'>>,
    requestId: string,
  ) {
    this.cleanup();
    if (
      [...this.jobs.values()].filter((job) => job.state === 'pending').length >=
      6
    )
      throw new ApiError(
        503,
        'BACKGROUND_BUSY',
        'Máy chủ đang xử lý nhiều ảnh. Vui lòng thử lại sau.',
        { retryable: true },
      );
    if (this.jobs.size >= 100) {
      const oldest = [...this.jobs.values()].find(
        (job) => job.state !== 'pending',
      );
      if (oldest) this.jobs.delete(oldest.jobId);
    }
    const job: Job = {
      jobId: randomUUID(),
      requestId,
      state: 'pending',
      expiresAt: Date.now() + 3600000,
    };
    this.jobs.set(job.jobId, job);
    const started = Date.now();
    void this.audit?.write('background_job_started', { jobId: job.jobId });
    // Detach model work from the short HTTP response while preserving its audit context.
    void Promise.resolve()
      .then(work)
      .then(
        (result) => {
          job.result = { ...result, requestId };
          job.state = 'done';
          job.expiresAt = Date.now() + 3600000;
          void this.audit?.write('background_job_completed', {
            jobId: job.jobId,
            durationMs: Date.now() - started,
          });
        },
        (exception: unknown) => {
          const raw =
            exception instanceof HttpException
              ? exception.getResponse()
              : undefined;
          const data =
            typeof raw === 'object' && raw !== null
              ? (raw as Record<string, unknown>)
              : {};
          job.error = {
            statusCode:
              exception instanceof HttpException ? exception.getStatus() : 500,
            code:
              typeof data.code === 'string'
                ? sanitizeErrorMessage(data.code)
                : 'BACKGROUND_JOB_FAILED',
            message:
              typeof data.message === 'string'
                ? sanitizeErrorMessage(data.message)
                : 'Không thể xử lý ảnh. Liên hệ quản trị viên kèm mã yêu cầu.',
            retryable: data.retryable === true,
            requestId,
          };
          for (const key of ['provider', 'reason', 'suggestion'])
            if (typeof data[key] === 'string')
              job.error[key] = sanitizeErrorMessage(data[key]);
          if (typeof data.upstreamStatus === 'number')
            job.error.upstreamStatus = data.upstreamStatus;
          job.state = 'failed';
          job.expiresAt = Date.now() + 3600000;
          void this.audit?.write('background_job_failed', {
            jobId: job.jobId,
            durationMs: Date.now() - started,
            error: job.error,
            diagnostic:
              exception instanceof Error
                ? sanitizeErrorMessage(exception.message)
                : undefined,
          });
        },
      );
    return { jobId: job.jobId, requestId, state: job.state };
  }

  get(id: string) {
    this.cleanup();
    const job = this.jobs.get(id);
    if (!job)
      throw new ApiError(
        404,
        'BACKGROUND_JOB_EXPIRED',
        'Tác vụ không còn trên máy chủ hoặc đã hết hạn. Hãy tạo lại ảnh.',
      );
    return {
      jobId: job.jobId,
      requestId: job.requestId,
      state: job.state,
      result: job.result,
      error: job.error,
    };
  }

  private cleanup() {
    for (const [id, job] of this.jobs)
      if (job.state !== 'pending' && job.expiresAt <= Date.now())
        this.jobs.delete(id);
  }
}
