import { HttpException, Injectable, OnModuleInit } from '@nestjs/common';
import { AgentStore } from '../agent/agent.store';
import type { AgentUser } from '../agent/agent.types';
import { TaskQueueService } from '../queue/task-queue.service';
import { AuditLogService } from '../audit/audit-log.service';
import { BackgroundService } from '../background/background.service';
import { MockupService } from '../mockup/mockup.service';
import { IdeaService } from '../idea/idea.service';
import { ImageJobsService } from './image-jobs.service';
import {
  restoreImage,
  type ImageTask,
  type QueuedImageJob,
} from './image-task';
import { ApiError } from './api-error';
import { sanitizeErrorMessage } from './error-sanitizer';

@Injectable()
export class ImageJobsWorker implements OnModuleInit {
  constructor(
    private readonly jobs: ImageJobsService,
    private readonly store: AgentStore,
    private readonly queue: TaskQueueService,
    private readonly backgrounds: BackgroundService,
    private readonly mockups: MockupService,
    private readonly ideas: IdeaService,
    private readonly audit: AuditLogService,
  ) {}
  onModuleInit() {
    this.queue.register('image', (task) => this.process(task.id, task.owner));
  }
  async process(id: string, owner: string) {
    const current = await this.store.get<QueuedImageJob>(
      'image-job',
      id,
      owner,
    );
    const job = await this.store.patch<QueuedImageJob>(
      'image-job',
      id,
      owner,
      {
        state: 'running',
        workerId: this.store.workerId,
        leaseUntil: Date.now() + 90000,
      },
      { state: 'queued' },
    );
    if (!job) return;
    const heartbeat = setInterval(
      () =>
        void this.store
          .patch<QueuedImageJob>(
            'image-job',
            id,
            owner,
            { leaseUntil: Date.now() + 90000 },
            { state: 'running', workerId: this.store.workerId },
          )
          .catch(() => undefined),
      15000,
    );
    heartbeat.unref();
    try {
      await this.audit.run(
        {
          requestId: current.requestId,
          method: 'WORKER',
          path: `/api/image-jobs/${id}`,
        },
        async () => {
          try {
            if (
              (await this.store.get<AgentUser>('user', owner, owner)).disabled
            )
              throw new ApiError(
                403,
                'AGENT_ACCOUNT_DISABLED',
                'Tài khoản đã bị khóa; tác vụ chưa gửi AI.',
              );
            const task = await this.jobs.payload(job);
            const output = await this.execute(task);
            const result =
              output && typeof output === 'object' && !Array.isArray(output)
                ? { ...output, requestId: job.requestId }
                : output;
            await this.store.patch<QueuedImageJob>(
              'image-job',
              id,
              owner,
              { state: 'done', result },
              {
                state: { $in: ['running', 'interrupted'] },
                workerId: this.store.workerId,
              },
            );
            await this.audit.write('background_job_completed', { jobId: id });
          } catch (error) {
            const raw =
              error instanceof HttpException ? error.getResponse() : undefined;
            const data =
              typeof raw === 'object' && raw !== null
                ? (raw as Record<string, unknown>)
                : {};
            const details: Record<string, unknown> = {
              statusCode:
                error instanceof HttpException ? error.getStatus() : 500,
              code:
                typeof data.code === 'string'
                  ? data.code
                  : 'BACKGROUND_JOB_FAILED',
              message: sanitizeErrorMessage(
                typeof data.message === 'string'
                  ? data.message
                  : 'Không hoàn tất tác vụ. Kiểm tra log kèm mã yêu cầu.',
              ),
              requestId: job.requestId,
              retryable: false,
            };
            for (const key of ['provider', 'reason', 'suggestion'])
              if (typeof data[key] === 'string')
                details[key] = sanitizeErrorMessage(data[key]);
            if (typeof data.upstreamStatus === 'number')
              details.upstreamStatus = data.upstreamStatus;
            await this.store.patch<QueuedImageJob>(
              'image-job',
              id,
              owner,
              {
                state: data.code === 'AI_TIMEOUT' ? 'interrupted' : 'failed',
                error: details,
              },
              { state: 'running', workerId: this.store.workerId },
            );
            await this.audit.write('background_job_failed', {
              jobId: id,
              error: details,
            });
          }
        },
      );
    } finally {
      clearInterval(heartbeat);
      await this.queue.release(`image-${id}`, owner);
    }
  }
  private execute(task: ImageTask): Promise<unknown> {
    const images = task.images.map(restoreImage);
    switch (task.operation) {
      case 'background':
        return this.backgrounds.replace({
          productImage: images[0],
          backgroundImage: images[1],
          instructions: task.prompt,
          variationIndex: task.variationIndex ?? 1,
          provider: task.provider,
          imageModel: task.imageModel,
        });
      case 'mockup':
        return this.mockups.generateMockup(
          images[0],
          task.prompt,
          undefined,
          task.provider,
          task.imageModel,
        );
      case 'mockup-batch':
        return this.mockups.generateMockups(
          images[0],
          task.prompts,
          undefined,
          task.provider,
          task.imageModel,
        );
      case 'ideas':
        return this.ideas.generateIdeasFromImage(
          images[0],
          task.prompt,
          task.count,
          undefined,
          task.provider,
          task.imageModel,
        );
      case 'references':
        return this.ideas.generateIdeasFromReferalImages({
          productImage: images[0],
          referenceImages: images.slice(1),
          variations: task.count,
          provider: task.provider,
          imageModel: task.imageModel,
        });
      case 'prompts':
        return this.mockups.generateMockupPrompts(
          images[0],
          task.count,
          undefined,
          task.provider,
        );
      case 'analyze':
        return this.ideas.analyzeProductFromImage(images[0], task.provider);
    }
  }
}
