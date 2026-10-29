import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  HttpException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AIService } from '../ai/ai.service';
import { AuditLogService } from '../audit/audit-log.service';
import { ApiError } from '../common/api-error';
import { sanitizeErrorMessage } from '../common/error-sanitizer';
import { TaskQueueService } from '../queue/task-queue.service';
import type { AgentUser, Asset } from '../agent/agent.types';
import { StudioService } from './studio.service';
import { BudgetService } from '../agent/budget.service';
import { StudioMockupWorker } from './studio-mockup.worker';
import type { TeamBudgetAccount } from '../agent/team-budget.types';
import type {
  StudioIdea,
  StudioSlot,
  StudioTicket,
  StudioPlanStep,
  StudioAssetRef,
} from './studio.types';
import { studioPrompt } from './studio.util';
import {
  artworkPrompt,
  thumbnailPrompt,
  prepareArtwork,
} from './studio-artwork';
import {
  analysisPrompt,
  briefsPrompt,
  creativeImagePrompt,
  readAnalysis,
  readBriefs,
} from './studio-planning';

@Injectable()
export class StudioWorker
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopping = false;
  private lifecycleTick?: Promise<void>;
  private lastBudgetRepair = 0;
  private readonly logger = new Logger(StudioWorker.name);
  constructor(
    private readonly studio: StudioService,
    private readonly queue: TaskQueueService,
    private readonly ai: AIService,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService,
    @Optional() private readonly budget?: BudgetService,
    @Optional() private readonly mockups?: StudioMockupWorker,
  ) {}
  onModuleInit() {
    this.queue.register('studio', (task) => this.execute(task.id, task.owner));
    this.queue.register('studio-plan', (task) =>
      this.executePlan(task.id, task.owner),
    );
  }
  onApplicationBootstrap() {
    if (
      !this.config.get<boolean>('STUDIO_ENABLED', false) ||
      !this.queue.enabled
    )
      return;
    this.timer = setInterval(() => {
      if (this.busy || this.stopping) return;
      this.lifecycleTick = this.tick();
      void this.lifecycleTick.catch(() =>
        this.logger.warn(
          'Studio dispatch unavailable; durable tasks are retained.',
        ),
      );
    }, 3000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.lifecycleTick?.catch(() => undefined);
  }
  async tick(now = new Date()) {
    if (this.busy || this.stopping) return;
    this.busy = true;
    const store = this.studio.store;
    try {
      await this.mockups?.tick(now);
      if (this.budget && Date.now() - this.lastBudgetRepair > 30000) {
        this.lastBudgetRepair = Date.now();
        for (const team of await store.query<TeamBudgetAccount>(
          'team-budget',
          {},
          200,
        ))
          await this.budget.repairTeamBudget(team.id);
      }
      for (const idea of await store.query<StudioIdea>(
        'studio-idea',
        { state: 'approved' },
        1000,
      ))
        await this.studio.ensureTicket(idea);
      for (const slot of await store.query<StudioSlot>(
        'studio-slot',
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
        await store.patch<StudioSlot>(
          'studio-slot',
          slot.id,
          slot.owner,
          result
            ? { state: 'done', resultId: result.id }
            : slot.state === 'preparing'
              ? { state: 'queued' }
              : {
                  state: 'interrupted',
                  error:
                    'Chưa xác định kết quả request. Không tự gửi lại để tránh tính phí trùng; cần quản trị viên đối soát.',
                },
          { state: slot.state, leaseUntil: { $lt: now.getTime() } },
        );
      }
      for (const plan of await store.query<StudioPlanStep>(
        'studio-plan',
        {
          state: { $in: ['preparing', 'submitted'] },
          leaseUntil: { $lt: now.getTime() },
        },
        1000,
      )) {
        await store.patch<StudioPlanStep>(
          'studio-plan',
          plan.id,
          plan.owner,
          {
            state: plan.state === 'preparing' ? 'queued' : 'interrupted',
            ...(plan.state === 'submitted'
              ? {
                  error:
                    'Bước phân tích/lập brief bị gián đoạn sau khi gửi. Cần đối soát; hệ thống không tự gọi AI lại.',
                }
              : {}),
          },
          {
            state: plan.state,
            attemptId: plan.attemptId,
            leaseUntil: { $lt: now.getTime() },
          },
        );
      }
      for (const ticket of await store.query<StudioTicket>(
        'studio-ticket',
        { state: { $in: ['scheduled', 'queued', 'running', 'cancelled'] } },
        1000,
      )) {
        if (ticket.state === 'scheduled') {
          if (
            Date.parse(ticket.dueAt) > now.getTime() ||
            !this.config.get<boolean>('STUDIO_SCHEDULER_ENABLED', false)
          )
            continue;
          // Missed windows require an explicit catch-up; restarts cannot silently spend an old batch's budget.
          await store.patch<StudioTicket>(
            'studio-ticket',
            ticket.id,
            ticket.owner,
            {
              claimedAt: now.toISOString(),
              state:
                now.getTime() - Date.parse(ticket.dueAt) > 5 * 60000
                  ? 'missed'
                  : 'queued',
            },
            { state: 'scheduled' },
          );
          continue;
        }
        if (ticket.state === 'cancelled') {
          for (const step of await store.query<StudioPlanStep>(
            'studio-plan',
            { ticketId: ticket.id, state: 'queued' },
            2,
          ))
            await store.patch<StudioPlanStep>(
              'studio-plan',
              step.id,
              step.owner,
              { state: 'cancelled' },
              { state: 'queued' },
            );
          for (const slot of await store.query<StudioSlot>(
            'studio-slot',
            { ticketId: ticket.id, state: 'queued' },
            100,
          ))
            await store.patch<StudioSlot>(
              'studio-slot',
              slot.id,
              slot.owner,
              { state: 'cancelled' },
              { state: 'queued' },
            );
          await this.queue.release(`studio-${ticket.id}`, ticket.owner);
          continue;
        }
        try {
          await this.checkPermission(ticket);
          await this.queue.reserve(`studio-${ticket.id}`, ticket.owner);
          const plan = ticket.snapshot.planningVersion
            ? await this.dispatchPlan(ticket)
            : undefined;
          if (ticket.snapshot.planningVersion && !plan) continue;
          const dispatchCount =
            ticket.dispatchCount ?? ticket.snapshot.input.count;
          for (let index = 0; index < dispatchCount; index++) {
            const artworkId = `${ticket.id}-artwork-${index}`;
            if (ticket.snapshot.input.artworkFirst) {
              const artwork = store.create<StudioSlot>(ticket.owner, {
                teamId: ticket.teamId,
                ticketId: ticket.id,
                index,
                role: 'artwork',
                state: 'queued',
                prompt: artworkPrompt(ticket.snapshot, plan.briefs[index]),
                requestId: randomUUID(),
              });
              artwork.id = artworkId;
              await store.ensure('studio-slot', artwork);
            }
            const slot = store.create<StudioSlot>(ticket.owner, {
              teamId: ticket.teamId,
              ticketId: ticket.id,
              index,
              state: 'queued',
              ...(ticket.snapshot.input.artworkFirst
                ? { role: 'thumbnail' as const, dependsOn: artworkId }
                : {}),
              prompt: ticket.snapshot.input.artworkFirst
                ? thumbnailPrompt(ticket.snapshot)
                : plan
                  ? creativeImagePrompt(
                      ticket.snapshot,
                      index,
                      plan.briefs[index],
                    )
                  : studioPrompt(ticket.snapshot, index),
              requestId: randomUUID(),
            });
            slot.id = `${ticket.id}-image-${index}`;
            await store.ensure('studio-slot', slot);
          }
          const slots = await store.query<StudioSlot>(
            'studio-slot',
            { ticketId: ticket.id },
            100,
          );
          for (const slot of slots.filter((s) => s.dependsOn)) {
            const parent = slots.find((s) => s.id === slot.dependsOn);
            if (
              parent &&
              ['failed', 'interrupted', 'cancelled'].includes(parent.state) &&
              slot.state === 'queued'
            ) {
              const saved = await store.patch<StudioSlot>(
                'studio-slot',
                slot.id,
                slot.owner,
                {
                  state: 'failed',
                  errorCode: 'STUDIO_DEPENDENCY_FAILED',
                  error: 'Chưa tạo được artwork gốc. Ảnh sản phẩm chưa gửi AI.',
                },
                { state: 'queued' },
              );
              if (saved) Object.assign(slot, saved);
            } else if (
              parent &&
              ['queued', 'preparing', 'submitted', 'done'].includes(
                parent.state,
              ) &&
              slot.state === 'failed' &&
              slot.errorCode === 'STUDIO_DEPENDENCY_FAILED'
            ) {
              const saved = await store.patch<StudioSlot>(
                'studio-slot',
                slot.id,
                slot.owner,
                { state: 'queued', error: '', errorCode: '' },
                { state: 'failed', errorCode: 'STUDIO_DEPENDENCY_FAILED' },
              );
              if (saved) Object.assign(slot, saved);
            }
          }
          if (
            slots.every((slot) =>
              ['done', 'failed', 'interrupted', 'cancelled'].includes(
                slot.state,
              ),
            )
          ) {
            const outputs = slots.filter((s) => s.role !== 'artwork');
            const done = outputs.filter((slot) => slot.state === 'done').length;
            await store.patch<StudioTicket>(
              'studio-ticket',
              ticket.id,
              ticket.owner,
              {
                state:
                  done === outputs.length
                    ? dispatchCount < ticket.snapshot.input.count
                      ? 'sample_review'
                      : 'review'
                    : done
                      ? 'partial_failed'
                      : 'failed',
              },
              { state: { $in: ['queued', 'running'] } },
            );
            await this.queue.release(`studio-${ticket.id}`, ticket.owner);
          } else {
            await this.queue.touch(`studio-${ticket.id}`, ticket.owner);
            for (const slot of slots.filter(
              (slot) =>
                slot.state === 'queued' &&
                (!slot.dependsOn ||
                  slots.some(
                    (s) => s.id === slot.dependsOn && s.state === 'done',
                  )),
            ))
              await this.queue.publish({
                kind: 'studio',
                id: slot.id,
                owner: slot.owner,
              });
          }
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.getStatus() < 500 &&
            error.getStatus() !== 429
          ) {
            await store.patch<StudioTicket>(
              'studio-ticket',
              ticket.id,
              ticket.owner,
              {
                state: 'blocked',
                error:
                  'Quyền hoặc dữ liệu đã thay đổi. Cần kiểm tra lại trước khi chạy.',
              },
              { state: { $in: ['queued', 'running'] } },
            );
            await this.queue
              .release(`studio-${ticket.id}`, ticket.owner)
              .catch(() => undefined);
          } else throw error;
        }
      }
    } finally {
      this.busy = false;
    }
  }
  private async checkPermission(ticket: StudioTicket) {
    const owner = await this.studio.store.find<AgentUser>('user', ticket.owner);
    const approver = await this.studio.store.find<AgentUser>(
      'user',
      ticket.approvedBy,
    );
    if (!owner || owner.disabled || !approver || approver.disabled)
      throw new ApiError(
        403,
        'STUDIO_ACCESS_REVOKED',
        'Tài khoản gửi hoặc duyệt đã bị khóa.',
      );
    this.studio.assertScheduleAccess(owner, ticket.snapshot.input);
    this.studio.assertScheduleAccess(approver, ticket.snapshot.input);
    const [shop] = await Promise.all([
      this.studio.shop(owner, ticket.storeId),
      this.studio.shop(approver, ticket.storeId, true),
    ]);
    if (!shop.productIds.includes(ticket.snapshot.product.id))
      throw new ApiError(
        403,
        'STUDIO_ACCESS_REVOKED',
        'Sản phẩm không còn được cấp cho cửa hàng.',
      );
    await Promise.all([
      this.studio.resource(
        owner,
        ticket.snapshot.product.id,
        ticket.teamId,
        'product',
      ),
      this.studio.resource(
        owner,
        ticket.snapshot.skill.id,
        ticket.teamId,
        'skill',
      ),
      this.studio.resource(
        owner,
        ticket.snapshot.thumbnail.id,
        ticket.teamId,
        'thumbnail',
      ),
    ]);
  }
  async execute(id: string, owner: string) {
    if (!this.config.get<boolean>('STUDIO_ENABLED', false)) return;
    const store = this.studio.store;
    const attemptId = randomUUID();
    const pending = await store.get<StudioSlot>('studio-slot', id, owner);
    if (pending.state !== 'queued') return;
    let artwork: Asset | undefined;
    if (pending.dependsOn) {
      const parent = await store.get<StudioSlot>(
        'studio-slot',
        pending.dependsOn,
        owner,
      );
      if (parent.state !== 'done' || !parent.resultId) return;
      artwork = await store.get<Asset>('asset', parent.resultId, owner);
    }
    const slot = await store.patch<StudioSlot>(
      'studio-slot',
      id,
      owner,
      { state: 'preparing', leaseUntil: Date.now() + 90000, attemptId },
      { state: 'queued' },
    );
    if (!slot) return;
    const heartbeat = setInterval(
      () =>
        void store
          .patch<StudioSlot>(
            'studio-slot',
            id,
            owner,
            { leaseUntil: Date.now() + 90000 },
            {
              state: { $in: ['preparing', 'submitted'] },
              requestId: slot.requestId,
              attemptId,
            },
          )
          .catch(() => undefined),
      15000,
    );
    heartbeat.unref();
    try {
      const ticket = await store.get<StudioTicket>(
        'studio-ticket',
        slot.ticketId,
        owner,
      );
      if (!['queued', 'running'].includes(ticket.state)) {
        await store.patch<StudioSlot>(
          'studio-slot',
          id,
          owner,
          { state: ticket.state === 'cancelled' ? 'cancelled' : 'queued' },
          { state: 'preparing', attemptId },
        );
        return;
      }
      await this.checkPermission(ticket);
      const images = await Promise.all(
        [
          artwork
            ? { id: artwork.id, owner: artwork.owner, sha256: artwork.sha256 }
            : ticket.snapshot.source,
          ticket.snapshot.master,
          ...(artwork ? [] : (ticket.snapshot.contextImages ?? [])),
        ].map(async (ref) => {
          const result = await this.studio.assets.read(ref.owner, ref.id);
          if (result.asset.sha256 !== ref.sha256)
            throw new ApiError(
              409,
              'STUDIO_IMAGE_CHANGED',
              'Ảnh đầu vào không khớp bản đã duyệt.',
            );
          return {
            base64: result.buffer.toString('base64'),
            mimeType: result.asset.mimeType,
          };
        }),
      );
      const latest = await store.get<StudioTicket>(
        'studio-ticket',
        ticket.id,
        owner,
      );
      if (!['queued', 'running'].includes(latest.state)) {
        await store.patch<StudioSlot>(
          'studio-slot',
          id,
          owner,
          { state: latest.state === 'cancelled' ? 'cancelled' : 'queued' },
          { state: 'preparing', attemptId },
        );
        return;
      }
      const submitted = await store.patch<StudioSlot>(
        'studio-slot',
        id,
        owner,
        { state: 'submitted', ...(artwork ? { artworkId: artwork.id } : {}) },
        { state: 'preparing', requestId: slot.requestId, attemptId },
      );
      if (!submitted) return;
      await store.patch<StudioTicket>(
        'studio-ticket',
        ticket.id,
        owner,
        { state: 'running' },
        { state: 'queued' },
      );
      await this.audit.run(
        {
          requestId: slot.requestId,
          method: 'WORKER',
          path: `/api/agent/studio/tickets/${ticket.id}`,
          owner,
          billingScope: `${slot.id}:${slot.requestId}`,
          billingTeamId: ticket.teamId,
        },
        async () => {
          await this.audit.write('studio_request_started', {
            ticketId: ticket.id,
            slotId: id,
            snapshotHash: ticket.snapshot.hash,
          });
          const buffer = await this.ai.composeImage(
            {
              prompt: slot.prompt,
              images,
              imageModel: ticket.snapshot.input.imageModel,
            },
            ticket.snapshot.input.provider,
          );
          const prepared =
            slot.role === 'artwork'
              ? await prepareArtwork(buffer, ticket.snapshot.product.printSpec)
              : undefined;
          const asset = await this.studio.assets.save(
            owner,
            prepared?.buffer ?? buffer,
            {
              name: `${ticket.snapshot.product.code}_${ticket.ideaId.slice(0, 8)}_${slot.role === 'artwork' ? 'artwork_' : ''}${String(slot.index + 1).padStart(2, '0')}.png`,
              kind: 'design',
              category: ticket.snapshot.product.name,
              stepId: slot.id,
              studioTicketId: ticket.id,
              ...(slot.role === 'artwork' && ticket.snapshot.product.printSpec
                ? { printSpec: ticket.snapshot.product.printSpec }
                : {}),
              ...(artwork ? { parentId: artwork.id } : {}),
              checks: prepared?.checks ?? {
                technical: true,
                visual: 'not_checked',
                notes: [
                  'Cần người dùng kiểm tra chữ, sản phẩm, hình học và watermark trước khi xuất.',
                ],
              },
            },
            true,
          );
          await store.patch<StudioSlot>(
            'studio-slot',
            id,
            owner,
            { state: 'done', resultId: asset.id },
            {
              state: { $in: ['submitted', 'interrupted'] },
              requestId: slot.requestId,
              attemptId,
            },
          );
          await this.audit.write('studio_request_completed', {
            ticketId: ticket.id,
            slotId: id,
            resultId: asset.id,
          });
        },
      );
    } catch (error) {
      const current = await store.get<StudioSlot>('studio-slot', id, owner);
      if (current.state === 'done' || current.resultId) return;
      const message = sanitizeErrorMessage(
        error instanceof Error ? error.message : 'Không hoàn tất tác vụ.',
      );
      const status = error instanceof HttpException ? error.getStatus() : 0;
      await store.patch<StudioSlot>(
        'studio-slot',
        id,
        owner,
        {
          state:
            current.state === 'submitted' && !(status >= 400 && status < 500)
              ? 'interrupted'
              : 'failed',
          error: message,
          errorCode: this.errorCode(error),
        },
        { state: { $in: ['preparing', 'submitted'] }, attemptId },
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async dispatchPlan(
    ticket: StudioTicket,
  ): Promise<StudioPlanStep | undefined> {
    const store = this.studio.store;
    for (const phase of ['analysis', 'briefs'] as const) {
      const step = store.create<StudioPlanStep>(ticket.owner, {
        ticketId: ticket.id,
        phase,
        state: 'queued',
        requestId: randomUUID(),
      });
      step.id = `${ticket.id}-${phase}`;
      await store.ensure('studio-plan', step);
      const saved = await store.get<StudioPlanStep>(
        'studio-plan',
        step.id,
        step.owner,
      );
      if (['failed', 'interrupted', 'cancelled'].includes(saved.state)) {
        await store.patch<StudioTicket>(
          'studio-ticket',
          ticket.id,
          ticket.owner,
          {
            state: 'blocked',
            error:
              saved.error ??
              'Bước chuẩn bị chưa hoàn tất. Chưa gửi yêu cầu tạo ảnh.',
          },
          { state: { $in: ['queued', 'running'] } },
        );
        await this.queue.release(`studio-${ticket.id}`, ticket.owner);
        return;
      }
      if (saved.state !== 'done') {
        await this.queue.touch(`studio-${ticket.id}`, ticket.owner);
        if (saved.state === 'queued')
          await this.queue.publish({
            kind: 'studio-plan',
            id: saved.id,
            owner: saved.owner,
          });
        return;
      }
      if (phase === 'briefs') return saved;
    }
  }
  private async readPlanningImage(ref: StudioAssetRef) {
    const { asset, buffer } = await this.studio.assets.read(ref.owner, ref.id);
    if (asset.sha256 !== ref.sha256)
      throw new ApiError(
        409,
        'STUDIO_IMAGE_CHANGED',
        'Ảnh không khớp snapshot đã duyệt.',
      );
    return {
      base64: (
        await sharp(buffer)
          .rotate()
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer()
      ).toString('base64'),
      mimeType: 'image/jpeg',
    };
  }
  async executePlan(id: string, owner: string) {
    if (!this.config.get<boolean>('STUDIO_ENABLED', false)) return;
    const store = this.studio.store;
    const attemptId = randomUUID();
    const step = await store.patch<StudioPlanStep>(
      'studio-plan',
      id,
      owner,
      { state: 'preparing', leaseUntil: Date.now() + 90000, attemptId },
      { state: 'queued' },
    );
    if (!step) return;
    const heartbeat = setInterval(
      () =>
        void store
          .patch<StudioPlanStep>(
            'studio-plan',
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
      const ticket = await store.get<StudioTicket>(
        'studio-ticket',
        step.ticketId,
        owner,
      );
      if (!['queued', 'running'].includes(ticket.state)) {
        await store.patch<StudioPlanStep>(
          'studio-plan',
          id,
          owner,
          { state: ticket.state === 'cancelled' ? 'cancelled' : 'queued' },
          { state: 'preparing', attemptId },
        );
        return;
      }
      await this.checkPermission(ticket);
      const images =
        step.phase === 'analysis'
          ? await Promise.all(
              [
                ticket.snapshot.source,
                ticket.snapshot.master,
                ...(ticket.snapshot.contextImages ?? []),
              ].map((ref) => this.readPlanningImage(ref)),
            )
          : undefined;
      const analysis =
        step.phase === 'briefs'
          ? await store.get<StudioPlanStep>(
              'studio-plan',
              `${ticket.id}-analysis`,
              owner,
            )
          : undefined;
      if (analysis && (analysis.state !== 'done' || !analysis.analysis))
        throw new ApiError(
          409,
          'STUDIO_ANALYSIS_REQUIRED',
          'Phân tích ảnh chưa hoàn tất.',
        );
      const latest = await store.get<StudioTicket>(
        'studio-ticket',
        ticket.id,
        owner,
      );
      if (!['queued', 'running'].includes(latest.state)) {
        await store.patch<StudioPlanStep>(
          'studio-plan',
          id,
          owner,
          { state: latest.state === 'cancelled' ? 'cancelled' : 'queued' },
          { state: 'preparing', attemptId },
        );
        return;
      }
      const submitted = await store.patch<StudioPlanStep>(
        'studio-plan',
        id,
        owner,
        { state: 'submitted' },
        { state: 'preparing', attemptId },
      );
      if (!submitted) return;
      await this.audit.run(
        {
          requestId: step.requestId,
          method: 'WORKER',
          path: `/api/agent/studio/tickets/${ticket.id}/plan`,
          owner,
          billingScope: `${step.id}:${step.requestId}`,
          billingTeamId: ticket.teamId,
        },
        async () => {
          await this.audit.write('studio_planning_started', {
            ticketId: ticket.id,
            phase: step.phase,
            snapshotHash: ticket.snapshot.hash,
          });
          const result =
            step.phase === 'analysis'
              ? {
                  analysis: readAnalysis(
                    await this.ai.analyzeStudioImages(
                      analysisPrompt(ticket.snapshot),
                      images,
                    ),
                  ),
                }
              : {
                  briefs: readBriefs(
                    await this.ai.agentJSON(
                      briefsPrompt(ticket.snapshot, analysis.analysis),
                    ),
                    ticket.snapshot.input.count,
                  ),
                };
          await store.patch<StudioPlanStep>(
            'studio-plan',
            id,
            owner,
            { ...result, state: 'done' },
            { state: { $in: ['submitted', 'interrupted'] }, attemptId },
          );
          await this.audit.write('studio_planning_completed', {
            ticketId: ticket.id,
            phase: step.phase,
          });
        },
      );
    } catch (error) {
      const current = await store.get<StudioPlanStep>('studio-plan', id, owner);
      if (current.state === 'done') return;
      const known =
        error instanceof ApiError &&
        /STUDIO_(?:ANALYSIS_INVALID|BRIEFS_INVALID|BRIEFS_DUPLICATED)/.test(
          String((error.getResponse() as { code?: string }).code),
        );
      const status = error instanceof HttpException ? error.getStatus() : 0;
      await store.patch<StudioPlanStep>(
        'studio-plan',
        id,
        owner,
        {
          state:
            current.state === 'submitted' &&
            !known &&
            !(status >= 400 && status < 500)
              ? 'interrupted'
              : 'failed',
          error: sanitizeErrorMessage(
            error instanceof Error
              ? error.message
              : 'Không hoàn tất bước chuẩn bị.',
          ),
          errorCode: this.errorCode(error),
        },
        { state: { $in: ['preparing', 'submitted'] }, attemptId },
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
  private errorCode(error: unknown) {
    const body: unknown =
      error instanceof HttpException ? error.getResponse() : undefined;
    return body &&
      typeof body === 'object' &&
      'code' in body &&
      typeof body.code === 'string'
      ? body.code
      : 'STUDIO_OUTCOME_UNKNOWN';
  }
}
