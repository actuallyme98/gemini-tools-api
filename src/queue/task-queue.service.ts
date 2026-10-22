import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Queue, Worker, DelayedError, type Job } from 'bullmq';
import Redis from 'ioredis';
import { AgentStore } from '../agent/agent.store';
import type { CompanySettings } from '../agent/agent.types';
import { ApiError } from '../common/api-error';

export type QueueTask = { kind: 'agent' | 'image'; id: string; owner: string };
export class QueueDeferred extends Error {}
type Handler = (task: QueueTask) => Promise<void>;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class TaskQueueService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TaskQueueService.name);
  private queue?: Queue<QueueTask>;
  private redis?: Redis;
  private worker?: Worker<QueueTask>;
  private readonly handlers = new Map<QueueTask['kind'], Handler>();
  readonly enabled: boolean;
  readonly prefix: string;
  private stopping = false;
  constructor(
    private readonly config: ConfigService,
    private readonly store: AgentStore,
  ) {
    this.enabled = config.get<boolean>('QUEUE_ENABLED', true);
    this.prefix = config.get<string>('QUEUE_PREFIX', 'lcgmedia-tools');
  }
  async onModuleInit() {
    if (!this.enabled) return;
    this.redis = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      lazyConnect: true,
      commandTimeout: 5000,
    });
    this.redis.on('error', () =>
      this.logger.warn('Redis queue connection unavailable.'),
    );
    await this.redis.connect();
    this.queue = new Queue<QueueTask>('ai-work', {
      connection: this.redis,
      prefix: this.prefix,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86400, count: 10000 },
        removeOnFail: { age: 604800, count: 10000 },
      },
    });
    this.queue.on('error', () =>
      this.logger.warn(
        'Queue command failed. Durable work remains in MongoDB.',
      ),
    );
    await this.queue.setGlobalConcurrency(
      this.config.get<number>('QUEUE_CONCURRENCY', 3),
    );
  }
  register(kind: QueueTask['kind'], handler: Handler) {
    this.handlers.set(kind, handler);
  }
  onApplicationBootstrap() {
    if (
      !this.enabled ||
      !this.config.get<boolean>('QUEUE_WORKER_ENABLED', true)
    )
      return;
    this.worker = new Worker<QueueTask>(
      'ai-work',
      (job, token) => this.process(job, token),
      {
        connection: {
          ...this.redis.options,
          maxRetriesPerRequest: null,
          enableOfflineQueue: true,
          commandTimeout: undefined,
          lazyConnect: false,
        },
        prefix: this.prefix,
        concurrency: this.config.get<number>('QUEUE_CONCURRENCY', 3),
        lockDuration: 90000,
        stalledInterval: 30000,
        maxStalledCount: 1,
      },
    );
    this.worker.on('error', () =>
      this.logger.warn('Queue worker connection unavailable; reconnecting.'),
    );
    this.worker.on('stalled', () =>
      this.logger.warn(
        'Queue delivery stalled. MongoDB execution guard prevents automatic AI resubmission.',
      ),
    );
    this.worker.on('failed', () =>
      this.logger.warn(
        'Queue delivery failed; inspect the durable task state before retrying.',
      ),
    );
  }
  private requireQueue() {
    if (!this.queue || !this.redis || this.stopping)
      throw new ApiError(
        503,
        'QUEUE_UNAVAILABLE',
        'Hàng đợi chưa sẵn sàng. Vui lòng thử lại sau.',
        { retryable: true },
      );
    return { queue: this.queue, redis: this.redis };
  }
  private admissionKey(owner: string) {
    return `${this.prefix}:admission:${hash(owner)}`;
  }
  async reserve(id: string, owner: string) {
    const { redis } = this.requireQueue();
    try {
      const accepted = await redis.eval(
        `
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
        redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])
        if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 1 end
        if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) or redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 0 end
        redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
        redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
        redis.call('EXPIRE', KEYS[2], 172800)
        return 1`,
        2,
        `${this.prefix}:admission:global`,
        this.admissionKey(owner),
        id,
        Date.now(),
        Date.now() + 86400000,
        this.config.get<number>('QUEUE_MAX_PENDING', 1000),
        this.config.get<number>('QUEUE_MAX_PENDING_PER_USER', 100),
      );
      if (!accepted)
        throw new ApiError(
          429,
          'QUEUE_CAPACITY_REACHED',
          'Hàng đợi đã đạt giới hạn cho tài khoản hoặc hệ thống. Chờ các công việc hiện tại hoàn tất rồi gửi thêm.',
          { retryable: true, retryAfterSeconds: 10 },
        );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'QUEUE_UNAVAILABLE',
        'Không kết nối được hàng đợi. Chưa tiếp nhận yêu cầu mới.',
        { retryable: true },
      );
    }
  }
  async release(id: string, owner: string) {
    const { redis } = this.requireQueue();
    await redis
      .multi()
      .zrem(`${this.prefix}:admission:global`, id)
      .zrem(this.admissionKey(owner), id)
      .exec();
  }
  async touch(id: string, owner: string) {
    const { redis } = this.requireQueue();
    await redis
      .multi()
      .zadd(`${this.prefix}:admission:global`, 'XX', Date.now() + 86400000, id)
      .zadd(this.admissionKey(owner), 'XX', Date.now() + 86400000, id)
      .expire(this.admissionKey(owner), 172800)
      .exec();
  }
  async publish(task: QueueTask) {
    const { queue } = this.requireQueue();
    if (task.kind === 'image') await this.touch(`image-${task.id}`, task.owner);
    const jobId = hash(`${task.kind}:${task.id}`);
    const existing = await queue.getJob(jobId);
    if (existing && ['failed', 'completed'].includes(await existing.getState()))
      await existing.remove();
    // Queue payloads contain IDs only; original prompts and images stay in MongoDB.
    await queue.add(task.kind, task, { jobId });
  }
  private async process(job: Job<QueueTask>, token?: string) {
    const handler = this.handlers.get(job.data.kind);
    if (!handler) throw new Error('Queue processor not registered');
    const { redis } = this.requireQueue();
    const key = `${this.prefix}:active:${hash(job.data.owner)}`;
    const member = `${job.id}:${token}`;
    let acquired = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      if (
        (await this.store.find<CompanySettings>('company-settings', 'company'))
          ?.queuePaused
      )
        throw new QueueDeferred();
      acquired = !!(await redis.eval(
        `
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
        if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
        redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
        redis.call('EXPIRE', KEYS[1], 180)
        return 1`,
        1,
        key,
        Date.now(),
        Date.now() + 90000,
        member,
        this.config.get<number>('QUEUE_USER_CONCURRENCY', 2),
      ));
      if (!acquired) throw new QueueDeferred();
      heartbeat = setInterval(
        () =>
          void redis
            .multi()
            .zadd(key, 'XX', Date.now() + 90000, member)
            .expire(key, 180)
            .exec()
            .catch(() => this.logger.warn('Queue user lease renewal failed.')),
        15000,
      );
      heartbeat.unref();
      await handler(job.data);
    } catch (error) {
      if (error instanceof QueueDeferred) {
        await job.moveToDelayed(Date.now() + 1000, token);
        throw new DelayedError();
      }
      // Delivery may fail, but only a fresh MongoDB queued -> running claim may call AI.
      throw new Error(
        'Queue delivery did not complete. Check durable task state.',
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (acquired) await redis.zrem(key, member).catch(() => undefined);
    }
  }
  async metrics() {
    try {
      const { queue } = this.requireQueue();
      return {
        available: true,
        ...(await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')),
        concurrency: this.config.get<number>('QUEUE_CONCURRENCY', 3),
        perUserConcurrency: this.config.get<number>(
          'QUEUE_USER_CONCURRENCY',
          2,
        ),
      };
    } catch {
      return { available: false };
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.worker) await this.worker.close();
    await this.queue?.close();
    this.redis?.disconnect();
  }
}
