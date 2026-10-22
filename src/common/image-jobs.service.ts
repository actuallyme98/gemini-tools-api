import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../agent/agent.store';
import { TaskQueueService } from '../queue/task-queue.service';
import { ApiError } from './api-error';
import type { ImageTask, QueuedImageJob } from './image-task';
import type { AgentRequest } from '../agent/agent-auth.service';
import type { Response } from 'express';
import { requestSignal } from './request-signal';

@Injectable()
export class ImageJobsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ImageJobsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(
    private readonly store: AgentStore,
    private readonly queue: TaskQueueService,
    private readonly config: ConfigService,
  ) {}
  async respond(
    task: ImageTask,
    req: AgentRequest,
    res: Response,
    asynchronous = false,
  ) {
    const key = req.get('Idempotency-Key');
    if (
      key &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        key,
      )
    )
      throw new ApiError(
        400,
        'JOB_ID_INVALID',
        'Idempotency-Key phải là UUID v4.',
      );
    const job = await this.create(
      task,
      String(res.getHeader('X-Request-Id') || randomUUID()),
      req.agentUser.id,
      key?.toLowerCase(),
    );
    res.setHeader('X-Job-Id', job.jobId);
    if (asynchronous) {
      res.status(202);
      return job;
    }
    return this.wait(job.jobId, req.agentUser.id, requestSignal(res));
  }

  async create(
    task: ImageTask,
    requestId: string,
    owner: string,
    id: string = randomUUID(),
  ) {
    const bytes = Buffer.from(JSON.stringify(task));
    if (bytes.length > 90 * 1024 * 1024)
      throw new ApiError(
        413,
        'JOB_INPUT_TOO_LARGE',
        'Bộ ảnh quá lớn. Chia nhỏ yêu cầu trước khi gửi.',
      );
    const inputHash = createHash('sha256').update(bytes).digest('hex');
    const existing = await this.store.find<QueuedImageJob>('image-job', id);
    if (existing) {
      if (existing.owner !== owner)
        throw new ApiError(
          404,
          'AGENT_NOT_FOUND',
          'Không tìm thấy dữ liệu trong tài khoản của bạn.',
        );
      if (existing.inputHash !== inputHash)
        throw new ApiError(
          409,
          'JOB_REQUEST_CONFLICT',
          'Mã yêu cầu đã được dùng với dữ liệu khác.',
        );
      return {
        jobId: id,
        requestId: existing.requestId,
        state: 'pending' as const,
      };
    }
    await this.queue.reserve(`image-${id}`, owner);
    const draft = this.store.create<QueuedImageJob>(owner, {
      state: 'preparing',
      requestId,
      inputHash,
      queueReleased: false,
    });
    draft.id = id;
    await this.store.ensure('image-job', draft);
    const saved = await this.store.get<QueuedImageJob>('image-job', id, owner);
    if (saved.inputHash !== inputHash)
      throw new ApiError(
        409,
        'JOB_REQUEST_CONFLICT',
        'Mã yêu cầu đã được dùng với dữ liệu khác.',
      );
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(
        this.config.getOrThrow<string>('AGENT_ASSET_ENCRYPTION_KEY'),
        'hex',
      ),
      iv,
    );
    cipher.setAAD(Buffer.from(`queue:${owner}:${id}`));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const storageKey = await this.store.backupImage(id, encrypted);
    const prepared = await this.store.patch<QueuedImageJob>(
      'image-job',
      id,
      owner,
      {
        state: 'queued',
        payload: {
          storageKey,
          iv: iv.toString('hex'),
          tag: cipher.getAuthTag().toString('hex'),
        },
      },
      { state: 'preparing' },
    );
    if (!prepared) await this.store.deleteImageBackup(storageKey);
    await this.queue
      .publish({ kind: 'image', id, owner })
      .catch(() =>
        this.logger.warn('Image job saved; waiting for Redis dispatch.'),
      );
    return { jobId: id, requestId, state: 'pending' as const };
  }
  async payload(job: QueuedImageJob): Promise<ImageTask> {
    if (!job.payload) throw new Error('Missing durable image input');
    const encrypted = await this.store.readImageBackup(
      job.payload.storageKey,
      90 * 1024 * 1024,
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(
        this.config.getOrThrow<string>('AGENT_ASSET_ENCRYPTION_KEY'),
        'hex',
      ),
      Buffer.from(job.payload.iv, 'hex'),
    );
    decipher.setAAD(Buffer.from(`queue:${job.owner}:${job.id}`));
    decipher.setAuthTag(Buffer.from(job.payload.tag, 'hex'));
    return JSON.parse(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
        'utf8',
      ),
    ) as ImageTask;
  }
  async get(id: string, owner: string) {
    const job = await this.store.get<QueuedImageJob>('image-job', id, owner);
    return {
      jobId: job.id,
      requestId: job.requestId,
      state:
        job.state === 'done'
          ? 'done'
          : ['failed', 'interrupted', 'cancelled'].includes(job.state)
            ? 'failed'
            : 'pending',
      phase: job.state,
      result: job.result,
      error: job.error,
    };
  }
  async wait(id: string, owner: string, signal?: AbortSignal) {
    for (let attempt = 0; attempt < 600; attempt++) {
      signal?.throwIfAborted();
      const job = await this.get(id, owner);
      if (job.state === 'done') return job.result;
      if (job.state === 'failed')
        throw new HttpException(
          job.error ?? {
            code: 'JOB_FAILED',
            message: 'Không hoàn tất tác vụ.',
            requestId: job.requestId,
          },
          Number(job.error?.statusCode) || 502,
        );
      await delay(1000, undefined, { signal });
    }
    throw new ApiError(
      504,
      'JOB_STILL_PENDING',
      'Tác vụ vẫn đang chờ hoặc xử lý. Tra cứu jobId để nhận kết quả, không gửi lại yêu cầu tạo ảnh.',
      { retryable: false, reason: id },
    );
  }
  onApplicationBootstrap() {
    if (!this.queue.enabled) return;
    this.timer = setInterval(
      () =>
        void this.reconcile().catch(() =>
          this.logger.warn(
            'Image job dispatch unavailable; durable tasks are retained.',
          ),
        ),
      2000,
    );
    this.timer.unref();
  }
  async reconcile() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const job of await this.store.query<QueuedImageJob>(
        'image-job',
        { state: 'queued' },
        1000,
      ))
        await this.queue.publish({
          kind: 'image',
          id: job.id,
          owner: job.owner,
        });
      for (const job of await this.store.query<QueuedImageJob>(
        'image-job',
        { state: 'running', leaseUntil: { $lt: Date.now() } },
        1000,
      ))
        await this.store.patch<QueuedImageJob>(
          'image-job',
          job.id,
          job.owner,
          {
            state: 'interrupted',
            error: {
              code: 'JOB_OUTCOME_UNKNOWN',
              statusCode: 409,
              message:
                'Worker bị gián đoạn. Provider có thể đã xử lý và tính phí; kiểm tra log trước khi tạo lại.',
              requestId: job.requestId,
              retryable: false,
            },
          },
          { state: 'running', leaseUntil: { $lt: Date.now() } },
        );
      for (const job of await this.store.query<QueuedImageJob>(
        'image-job',
        {
          state: 'preparing',
          createdAt: { $lt: new Date(Date.now() - 300000).toISOString() },
        },
        1000,
      ))
        await this.store.patch<QueuedImageJob>(
          'image-job',
          job.id,
          job.owner,
          {
            state: 'failed',
            error: {
              code: 'JOB_INPUT_INTERRUPTED',
              statusCode: 503,
              message:
                'Chưa lưu xong ảnh đầu vào; chưa gọi AI. Hãy tạo lại yêu cầu.',
              requestId: job.requestId,
              retryable: true,
            },
          },
          { state: 'preparing' },
        );
      for (const job of await this.store.query<QueuedImageJob>(
        'image-job',
        {
          queueReleased: false,
          state: { $in: ['done', 'failed', 'interrupted', 'cancelled'] },
        },
        1000,
      )) {
        await this.queue.release(`image-${job.id}`, job.owner);
        await this.store.patch<QueuedImageJob>('image-job', job.id, job.owner, {
          queueReleased: true,
        });
      }
    } finally {
      this.busy = false;
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
