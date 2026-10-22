import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  HttpException,
} from '@nestjs/common';
import { AgentStore } from './agent.store';
import { AgentService } from './agent.service';
import { AuditLogService } from '../audit/audit-log.service';
import { sanitizeErrorMessage } from '../common/error-sanitizer';
import type { AgentUser, Run, Step } from './agent.types';
import { TaskQueueService, QueueDeferred } from '../queue/task-queue.service';

@Injectable()
export class AgentWorker
  implements OnApplicationBootstrap, OnModuleDestroy, OnModuleInit
{
  private readonly logger = new Logger(AgentWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  constructor(
    private readonly store: AgentStore,
    private readonly agent: AgentService,
    private readonly audit: AuditLogService,
    private readonly queue: TaskQueueService,
  ) {}
  onModuleInit() {
    this.queue.register('agent', async (task) => {
      const pending = await this.store.get<Step>('step', task.id, task.owner);
      if (pending.state !== 'queued') return;
      const step = await this.store.claim(task.id, task.owner);
      if (!step) throw new QueueDeferred();
      await this.execute(step);
    });
  }
  onApplicationBootstrap() {
    if (!this.store.enabled || !this.queue.enabled) return;
    this.timer = setInterval(
      () =>
        void this.tick().catch(() =>
          this.logger.error(
            'Agent queue unavailable; will reconnect without repeating submitted AI calls.',
          ),
        ),
      1000,
    );
    this.timer.unref();
  }
  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      for (const stale of await this.store.query<Step>('step', {
        state: 'running',
        leaseUntil: { $lt: Date.now() },
      })) {
        const updated = await this.store.patch<Step>(
          'step',
          stale.id,
          stale.owner,
          {
            state: 'interrupted',
            errorCode: 'AGENT_OUTCOME_UNKNOWN',
            error:
              'Worker bị gián đoạn. Provider có thể đã tính phí; kiểm tra kết quả và log trước khi tạo lại.',
          },
          { state: 'running', leaseUntil: { $lt: Date.now() } },
        );
        if (!updated) continue;
        if (stale.type === 'plan')
          await this.store.patch<Run>(
            'run',
            stale.runId,
            stale.owner,
            { state: 'failed' },
            { state: 'planning' },
          );
        else await this.agent.refreshRun(stale.runId, stale.owner);
      }
      for (const run of await this.store.query<Run>(
        'run',
        {
          state: { $in: ['planning', 'queued', 'running'] },
          queuePrepared: { $ne: true },
        },
        100,
      ))
        await this.agent.ensureSteps(run);
      const pending = await this.store.query<Step>(
        'step',
        { state: 'queued' },
        1000,
      );
      const pendingRuns = new Map<string, Step>();
      for (const step of pending) pendingRuns.set(step.runId, step);
      for (const step of pendingRuns.values())
        await this.queue.touch(
          `agent-${step.runId}-${step.type === 'plan' ? 'plan' : 'image'}`,
          step.owner,
        );
      for (const step of pending)
        await this.queue.publish({
          kind: 'agent',
          id: step.id,
          owner: step.owner,
        });
      for (const run of await this.store.query<Run>(
        'run',
        {
          queueAdmissionReleased: false,
          state: { $nin: ['planning', 'queued', 'running'] },
        },
        1000,
      ))
        await this.releaseAdmission(run, run.queueAdmission);
    } finally {
      this.busy = false;
    }
  }
  private async execute(step: Step) {
    const heartbeat = setInterval(
      () =>
        void this.store
          .heartbeat(step)
          .catch(() => this.logger.warn('Agent lease heartbeat unavailable.')),
      15000,
    );
    heartbeat.unref();
    try {
      await this.audit.run(
        {
          requestId: step.requestId,
          method: 'WORKER',
          path: `/api/agent/runs/${step.runId}`,
        },
        async () => {
          const run = await this.store.get<Run>('run', step.runId, step.owner);
          if (run.state === 'cancelled') {
            await this.store.patch<Step>(
              'step',
              step.id,
              step.owner,
              { state: 'cancelled' },
              { state: 'running', workerId: this.store.workerId },
            );
            return;
          }
          await this.audit.write('agent_step_started', {
            runId: run.id,
            stepId: step.id,
            type: step.type,
            provider: run.provider,
            imageModel: run.imageModel,
          });
          try {
            if (
              (await this.store.get<AgentUser>('user', run.owner, run.owner))
                .disabled
            )
              throw new HttpException(
                {
                  code: 'AGENT_ACCOUNT_DISABLED',
                  message:
                    'Tài khoản đã bị khóa; không gửi tác vụ tiếp theo đến AI.',
                },
                403,
              );
            if (step.type === 'plan') await this.agent.plan(run);
            else {
              await this.store.patch<Run>(
                'run',
                run.id,
                run.owner,
                { state: 'running' },
                { state: 'queued' },
              );
              await this.agent.image(run, step);
            }
            await this.store.patch<Step>(
              'step',
              step.id,
              step.owner,
              {
                state: 'done',
                durationMs: Date.now() - Date.parse(step.startedAt),
              },
              {
                state: { $in: ['running', 'interrupted'] },
                workerId: this.store.workerId,
              },
            );
            await this.audit.write('agent_step_completed', {
              runId: run.id,
              stepId: step.id,
            });
          } catch (error) {
            const response =
              error instanceof HttpException ? error.getResponse() : undefined;
            const data =
              typeof response === 'object' && response !== null
                ? (response as Record<string, unknown>)
                : {};
            const message = sanitizeErrorMessage(
              typeof data.message === 'string'
                ? data.message
                : 'Không hoàn tất tác vụ. Xem mã yêu cầu để kiểm tra log.',
            );
            const code =
              typeof data.code === 'string' ? data.code : 'AGENT_STEP_FAILED';
            const uncertain = step.type === 'image' && code === 'AI_TIMEOUT';
            await this.store.patch<Step>(
              'step',
              step.id,
              step.owner,
              {
                state:
                  code === 'AGENT_CANCELLED'
                    ? 'cancelled'
                    : uncertain
                      ? 'interrupted'
                      : 'failed',
                error: uncertain
                  ? `${message} Provider có thể đã xử lý và tính phí; kiểm tra log trước khi tạo lại.`
                  : message,
                errorCode: code,
                durationMs: Date.now() - Date.parse(step.startedAt),
              },
              { state: 'running', workerId: this.store.workerId },
            );
            if (step.type === 'plan')
              await this.store.patch<Run>(
                'run',
                run.id,
                run.owner,
                { state: 'failed' },
                { state: 'planning' },
              );
            await this.audit.write('agent_step_failed', {
              runId: run.id,
              stepId: step.id,
              code,
              message,
              diagnostic: sanitizeErrorMessage(
                error instanceof Error ? error.message : 'Unknown',
              ),
            });
            if (
              [
                'AI_AUTHENTICATION_FAILED',
                'AI_QUOTA_EXCEEDED',
                'AI_BILLING_BLOCKED',
                'AI_PERMISSION_DENIED',
                'AGENT_ACCOUNT_DISABLED',
              ].includes(code) ||
              code.startsWith('STORAGE_')
            )
              await this.agent.cancel(run.owner, run.id);
          }
          await this.agent.refreshRun(run.id, run.owner);
        },
      );
    } finally {
      clearInterval(heartbeat);
      await this.store.release(step);
      const run = await this.store.get<Run>('run', step.runId, step.owner);
      if (step.type === 'plan' || !['queued', 'running'].includes(run.state))
        await this.releaseAdmission(
          run,
          step.type === 'plan' ? 'plan' : 'image',
        );
    }
  }
  private async releaseAdmission(run: Run, phase: 'plan' | 'image') {
    await this.queue.release(`agent-${run.id}-${phase}`, run.owner);
    await this.store.releaseAdmission(run.id, run.owner, phase);
  }
  onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }
}
