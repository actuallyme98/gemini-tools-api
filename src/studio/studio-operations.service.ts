import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { StudioService } from './studio.service';
import { BudgetService } from '../agent/budget.service';
import { adminAction } from '../agent/admin-audit';
import { ApiError } from '../common/api-error';
import type { AgentUser } from '../agent/agent.types';
import type {
  StudioBatch,
  StudioOccurrence,
  StudioPlanStep,
  StudioSlot,
  StudioTicket,
} from './studio.types';

@Injectable()
export class StudioOperationsService {
  constructor(
    private readonly studio: StudioService,
    private readonly budget: BudgetService,
  ) {}
  async batches(page: number) {
    const result = await this.studio.store.adminPage<StudioBatch>(
      'studio-batch',
      {},
      page,
      20,
    );
    const counts = await this.studio.store.studioBatchCounts(
      result.items.map((batch) => batch.id),
    );
    const items = result.items.map((batch) => {
      const states = Object.fromEntries(
        counts
          .filter((row) => row._id.batchId === batch.id)
          .map((row) => [row._id.state, row.count]),
      );
      return {
        ...batch,
        states,
        ticketCount: Object.values(states).reduce(
          (sum, count) => sum + count,
          0,
        ),
      };
    });
    return { ...result, items };
  }
  async batch(user: AgentUser, id: string, page: number) {
    const batch = await this.studio.store.find<StudioBatch>('studio-batch', id);
    if (!batch)
      throw new ApiError(404, 'STUDIO_NOT_FOUND', 'Không tìm thấy lô chạy.');
    this.requireAdmin(user);
    const occurrence = await this.studio.store.find<StudioOccurrence>(
      'studio-occurrence',
      batch.occurrenceId,
    );
    return {
      batch,
      occurrence,
      ...(await this.studio.store.adminPage<StudioTicket>(
        'studio-ticket',
        { batchId: id },
        page,
        30,
      )),
    };
  }
  async tasks(user: AgentUser, id: string) {
    this.requireAdmin(user);
    const ticket = await this.studio.store.find<StudioTicket>(
      'studio-ticket',
      id,
    );
    if (!ticket)
      throw new ApiError(404, 'STUDIO_NOT_FOUND', 'Không tìm thấy lượt chạy.');
    const [slots, plans] = await Promise.all([
      this.studio.store.query<StudioSlot>('studio-slot', { ticketId: id }, 100),
      this.studio.store.query<StudioPlanStep>(
        'studio-plan',
        { ticketId: id },
        2,
      ),
    ]);
    return { ticket, slots, plans };
  }
  private requireAdmin(user: AgentUser) {
    if (user.role !== 'admin' || user.disabled)
      throw new ApiError(
        403,
        'AGENT_ADMIN_REQUIRED',
        'Chỉ quản trị viên được xem vận hành.',
      );
  }
  async resumeBudget(user: AgentUser, id: string, reason: string) {
    const current = await this.tasks(user, id);
    return adminAction(
      this.studio.store,
      user,
      'studio.ticket.resume_budget',
      id,
      { reason },
      async () => {
        if (
          !['blocked', 'failed', 'partial_failed'].includes(
            current.ticket.state,
          )
        )
          throw new ApiError(
            409,
            'STUDIO_STATE_CHANGED',
            'Chỉ tiếp tục lượt bị chặn hoặc lỗi trước khi gửi AI.',
          );
        const steps = [...current.plans, ...current.slots];
        if (
          steps.some((step) =>
            ['submitted', 'preparing', 'interrupted'].includes(step.state),
          )
        )
          throw new ApiError(
            409,
            'STUDIO_RECONCILIATION_REQUIRED',
            'Còn request đang chạy hoặc chưa rõ kết quả. Cần đối soát trước, không tự gửi lại.',
          );
        const safeCodes = [
          'TEAM_BUDGET_EXCEEDED',
          'USER_BUDGET_EXCEEDED',
          'BUDGET_PRICING_UNAVAILABLE',
          'TEAM_BUDGET_ACCESS_REVOKED',
          'STUDIO_ACCESS_REVOKED',
        ];
        const reset = steps.filter(
          (step) =>
            step.state === 'failed' && safeCodes.includes(step.errorCode ?? ''),
        );
        if (!reset.length && !steps.some((step) => step.state === 'queued'))
          throw new ApiError(
            409,
            'STUDIO_RECONCILIATION_REQUIRED',
            'Không có request được xác định chắc chắn chưa gửi do hạn mức/giá/quyền.',
          );
        await this.budget.repairTeamBudget(current.ticket.teamId);
        for (const step of reset) {
          const kind = 'phase' in step ? 'studio-plan' : 'studio-slot';
          await this.studio.store.patch<StudioPlanStep | StudioSlot>(
            kind,
            step.id,
            step.owner,
            {
              state: 'queued',
              requestId: randomUUID(),
              error: '',
              errorCode: '',
            },
            {
              state: 'failed',
              requestId: step.requestId,
              errorCode: step.errorCode,
            },
          );
        }
        const saved = await this.studio.store.patch<StudioTicket>(
          'studio-ticket',
          id,
          current.ticket.owner,
          { state: 'queued', error: '' },
          { state: current.ticket.state },
        );
        if (!saved)
          throw new ApiError(
            409,
            'STUDIO_STATE_CHANGED',
            'Lượt chạy đã được thay đổi. Tải lại trạng thái.',
          );
        return saved;
      },
    );
  }
}
