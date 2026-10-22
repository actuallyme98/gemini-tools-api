import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStore } from './agent.store';
import { AgentService } from './agent.service';
import { AuditLogService } from '../audit/audit-log.service';
import { sanitizeErrorMessage } from '../common/error-sanitizer';
import type { Run, Step } from './agent.types';

@Injectable()
export class AgentWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private active = new Set<Promise<void>>();
  constructor(
    private readonly store: AgentStore,
    private readonly agent: AgentService,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService,
  ) {}
  onApplicationBootstrap() {
    if (
      !this.store.enabled ||
      !this.config.get<boolean>('AGENT_WORKER_ENABLED', true)
    )
      return;
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
      while (
        this.active.size < this.config.get<number>('AGENT_CONCURRENCY', 3) &&
        !this.stopping
      ) {
        const step = await this.store.claim();
        if (!step) break;
        const promise = this.execute(step)
          .catch(() =>
            this.logger.error(
              'Agent step update failed; lease recovery will retain its uncertain outcome.',
            ),
          )
          .finally(() => this.active.delete(promise));
        this.active.add(promise);
      }
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
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.race([
      Promise.allSettled([...this.active]),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 25000);
        timer.unref();
      }),
    ]);
  }
}
