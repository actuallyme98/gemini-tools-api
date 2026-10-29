import { HttpException, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { StudioMockupService } from './studio-mockup.service';
import type { StudioMockup, StudioMockupSlot } from './studio-mockup.types';
import { TaskQueueService } from '../queue/task-queue.service';
import { AIService } from '../ai/ai.service';
import { AuditLogService } from '../audit/audit-log.service';
import { ApiError } from '../common/api-error';
import { sanitizeErrorMessage } from '../common/error-sanitizer';
import type { Asset } from '../agent/agent.types';

@Injectable()
export class StudioMockupWorker implements OnModuleInit {
  constructor(
    private readonly mockups: StudioMockupService,
    private readonly queue: TaskQueueService,
    private readonly ai: AIService,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    this.queue.register('studio-mockup', (task) =>
      this.execute(task.id, task.owner),
    );
  }
  async tick(now = new Date()) {
    const store = this.mockups.studio.store;
    for (const slot of await store.query<StudioMockupSlot>(
      'studio-mockup-slot',
      {
        state: { $in: ['preparing', 'submitted'] },
        leaseUntil: { $lt: now.getTime() },
      },
      1000,
    )) {
      const result = (
        await store.query<Asset>(
          'asset',
          { owner: slot.owner, stepId: slot.id },
          1,
        )
      )[0];
      await store.patch<StudioMockupSlot>(
        'studio-mockup-slot',
        slot.id,
        slot.owner,
        result
          ? { state: 'done', resultId: result.id }
          : slot.state === 'preparing'
            ? { state: 'queued' }
            : {
                state: 'interrupted',
                error:
                  'Request đã gửi nhưng chưa rõ kết quả. Cần đối soát, không tự gửi lại.',
              },
        {
          state: slot.state,
          attemptId: slot.attemptId,
          leaseUntil: { $lt: now.getTime() },
        },
      );
    }
    for (const job of await store.query<StudioMockup>(
      'studio-mockup',
      { state: { $in: ['queued', 'running', 'cancelled'] } },
      1000,
    )) {
      if (job.state === 'cancelled') {
        for (const slot of await store.query<StudioMockupSlot>(
          'studio-mockup-slot',
          { jobId: job.id, state: 'queued' },
          100,
        ))
          await store.patch<StudioMockupSlot>(
            'studio-mockup-slot',
            slot.id,
            slot.owner,
            { state: 'cancelled' },
            { state: 'queued' },
          );
        await this.queue.release(job.id, job.owner);
        continue;
      }
      try {
        await this.mockups.checkPermission(job);
        await this.queue.reserve(job.id, job.owner);
        await this.mockups.ensureSlots(job);
        const slots = await store.query<StudioMockupSlot>(
          'studio-mockup-slot',
          { jobId: job.id },
          100,
        );
        if (
          slots.length === job.count &&
          slots.every((s) =>
            ['done', 'failed', 'interrupted', 'cancelled'].includes(s.state),
          )
        ) {
          const done = slots.filter((s) => s.state === 'done').length;
          await store.patch<StudioMockup>(
            'studio-mockup',
            job.id,
            job.owner,
            {
              state:
                done === job.count
                  ? 'review'
                  : done
                    ? 'partial_failed'
                    : 'failed',
            },
            { state: { $in: ['queued', 'running'] } },
          );
          await this.queue.release(job.id, job.owner);
        } else {
          await this.queue.touch(job.id, job.owner);
          for (const slot of slots.filter((s) => s.state === 'queued'))
            await this.queue.publish({
              kind: 'studio-mockup',
              id: slot.id,
              owner: slot.owner,
            });
        }
      } catch (error) {
        if (
          error instanceof HttpException &&
          error.getStatus() < 500 &&
          error.getStatus() !== 429
        ) {
          await store.patch<StudioMockup>(
            'studio-mockup',
            job.id,
            job.owner,
            {
              state: 'blocked',
              error:
                'Quyền, ảnh nguồn được duyệt hoặc bối cảnh không còn hợp lệ. Kiểm tra rồi tiếp tục phần còn thiếu.',
            },
            { state: { $in: ['queued', 'running'] } },
          );
          await this.queue.release(job.id, job.owner);
        } else throw error;
      }
    }
  }
  async execute(id: string, owner: string) {
    if (!this.config.get<boolean>('STUDIO_ENABLED', false)) return;
    const store = this.mockups.studio.store;
    const attemptId = randomUUID();
    const slot = await store.patch<StudioMockupSlot>(
      'studio-mockup-slot',
      id,
      owner,
      { state: 'preparing', attemptId, leaseUntil: Date.now() + 90000 },
      { state: 'queued' },
    );
    if (!slot) return;
    const heartbeat = setInterval(
      () =>
        void store
          .patch<StudioMockupSlot>(
            'studio-mockup-slot',
            id,
            owner,
            { leaseUntil: Date.now() + 90000 },
            { state: { $in: ['preparing', 'submitted'] }, attemptId },
          )
          .catch(() => undefined),
      15000,
    );
    heartbeat.unref();
    try {
      const job = await store.get<StudioMockup>(
        'studio-mockup',
        slot.jobId,
        owner,
      );
      if (!['queued', 'running'].includes(job.state)) {
        await store.patch<StudioMockupSlot>(
          'studio-mockup-slot',
          id,
          owner,
          { state: job.state === 'cancelled' ? 'cancelled' : 'queued' },
          { state: 'preparing', attemptId },
        );
        return;
      }
      await this.mockups.checkPermission(job);
      const source = job.sources[slot.sourceIndex],
        scene = job.scenes.find((s) => s.id === slot.sceneId);
      const images = await Promise.all(
        [source.image, scene.image].map(async (ref) => {
          const { asset, buffer } = await this.mockups.studio.assets.read(
            ref.owner,
            ref.id,
            owner,
          );
          if (asset.sha256 !== ref.sha256)
            throw new ApiError(
              409,
              'STUDIO_IMAGE_CHANGED',
              'Ảnh không khớp đầu vào đã chốt.',
            );
          return {
            base64: buffer.toString('base64'),
            mimeType: asset.mimeType,
          };
        }),
      );
      await this.mockups.checkPermission(job);
      const latest = await store.get<StudioMockup>(
        'studio-mockup',
        job.id,
        owner,
      );
      if (!['queued', 'running'].includes(latest.state)) {
        await store.patch<StudioMockupSlot>(
          'studio-mockup-slot',
          id,
          owner,
          { state: latest.state === 'cancelled' ? 'cancelled' : 'queued' },
          { state: 'preparing', attemptId },
        );
        return;
      }
      if (
        !(await store.patch<StudioMockupSlot>(
          'studio-mockup-slot',
          id,
          owner,
          { state: 'submitted' },
          { state: 'preparing', attemptId, requestId: slot.requestId },
        ))
      )
        return;
      await store.patch<StudioMockup>(
        'studio-mockup',
        job.id,
        owner,
        { state: 'running' },
        { state: 'queued' },
      );
      await this.audit.run(
        {
          owner,
          requestId: slot.requestId,
          method: 'WORKER',
          path: `/api/agent/studio/mockups/${job.id}`,
          billingTeamId: job.teamId,
          billingScope: `${slot.id}:${slot.requestId}`,
        },
        async () => {
          await this.audit.write('studio_mockup_started', {
            jobId: job.id,
            slotId: id,
            sourceId: source.image.id,
            sceneId: scene.id,
            color: slot.color,
          });
          const buffer = await this.ai.composeImage(
            { prompt: slot.prompt, images, imageModel: job.imageModel },
            job.provider,
          );
          const asset = await this.mockups.studio.assets.save(
            owner,
            buffer,
            {
              kind: 'result',
              name: `${job.product.code}_${job.id.slice(-8)}_${slot.index + 1}.png`,
              category: job.product.name,
              stepId: slot.id,
              studioMockupId: job.id,
              checks: {
                technical: true,
                visual: 'not_checked',
                notes: [
                  'Cần kiểm tra đúng thiết kế, số lượng sản phẩm, phối cảnh và không có watermark.',
                ],
              },
            },
            true,
          );
          await store.patch<StudioMockupSlot>(
            'studio-mockup-slot',
            id,
            owner,
            { state: 'done', resultId: asset.id },
            {
              state: { $in: ['submitted', 'interrupted'] },
              attemptId,
              requestId: slot.requestId,
            },
          );
          await this.audit.write('studio_mockup_completed', {
            jobId: job.id,
            slotId: id,
            resultId: asset.id,
          });
        },
      );
    } catch (error) {
      const current = await store.get<StudioMockupSlot>(
        'studio-mockup-slot',
        id,
        owner,
      );
      if (current.state === 'done') return;
      const raw =
        error instanceof HttpException ? error.getResponse() : undefined;
      const response =
        typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
      const status = error instanceof HttpException ? error.getStatus() : 0;
      await store.patch<StudioMockupSlot>(
        'studio-mockup-slot',
        id,
        owner,
        {
          state:
            current.state === 'submitted' && !(status >= 400 && status < 500)
              ? 'interrupted'
              : 'failed',
          error: sanitizeErrorMessage(
            error instanceof Error
              ? error.message
              : 'Không hoàn tất ảnh mockup.',
          ),
          errorCode:
            typeof response.code === 'string'
              ? response.code
              : 'STUDIO_OUTCOME_UNKNOWN',
        },
        { state: { $in: ['preparing', 'submitted'] }, attemptId },
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
}
