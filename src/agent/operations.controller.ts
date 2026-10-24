import {
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { statfs } from 'node:fs/promises';
import {
  AgentGuard,
  AgentAdminGuard,
  type AgentRequest,
} from './agent-auth.service';
import { AgentStore } from './agent.store';
import { AgentDatabaseFilter } from './agent-database.filter';
import { BudgetService } from './budget.service';
import { ProviderUsageService } from './provider-usage.service';
import { TaskQueueService } from '../queue/task-queue.service';
import { idSchema, parse } from './agent.schemas';
import type { AgentUser, Entity, Step } from './agent.types';
export interface AgentNotification extends Entity {
  runId: string;
  conversationId: string;
  state: string;
  title: string;
  read: boolean;
  eventKey: string;
}
async function storageVolume(): Promise<{
  freeBytes: number;
  totalBytes: number;
  scope: string;
} | null> {
  try {
    const stats = await statfs(process.cwd());
    return {
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
      scope: 'application_volume',
    };
  } catch {
    return null;
  }
}
@Controller('agent')
@UseGuards(AgentGuard)
@UseFilters(AgentDatabaseFilter)
export class OperationsController {
  constructor(
    private readonly store: AgentStore,
    private readonly budget: BudgetService,
    private readonly provider: ProviderUsageService,
    private readonly queue: TaskQueueService,
  ) {}
  @Get('notifications')
  @Header('Cache-Control', 'no-store')
  async notifications(@Req() req: AgentRequest) {
    return this.store.list<AgentNotification>(
      'notification',
      req.agentUser.id,
      100,
    );
  }
  @Patch('notifications/:id/read') async read(
    @Req() req: AgentRequest,
    @Param('id') value: string,
  ) {
    const id = parse<string>(idSchema.required(), value);
    await this.store.get('notification', id, req.agentUser.id);
    return this.store.patch<AgentNotification>(
      'notification',
      id,
      req.agentUser.id,
      { read: true },
    );
  }
  @Get('admin/operations')
  @UseGuards(AgentAdminGuard)
  @Header('Cache-Control', 'no-store')
  async operations() {
    const [metrics, providers, users, stuck, failed, disk] = await Promise.all([
      this.queue.metrics(),
      this.provider.usage(),
      this.store.query<AgentUser>('user', { disabled: { $ne: true } }, 500),
      this.store.query<Step>(
        'step',
        {
          state: { $in: ['queued', 'running'] },
          createdAt: { $lt: new Date(Date.now() - 15 * 60000).toISOString() },
        },
        100,
      ),
      this.store.query<Step>(
        'step',
        {
          state: { $in: ['failed', 'interrupted'] },
          updatedAt: { $gte: new Date(Date.now() - 3600000).toISOString() },
        },
        100,
        -1,
      ),
      storageVolume(),
    ]);
    const budgets = await this.budget.summaries(users.map((u) => u.id));
    return {
      generatedAt: new Date().toISOString(),
      queue: metrics,
      providers: providers.items,
      disk,
      alerts: [
        ...(metrics.available
          ? []
          : [
              {
                severity: 'error',
                code: 'QUEUE_UNAVAILABLE',
                target: 'queue',
                message:
                  'Không truy cập được Redis/BullMQ. Chưa thể xác nhận hàng đợi hoạt động.',
              },
            ]),
        ...stuck.map((s) => ({
          severity: 'warning',
          code: 'QUEUE_LONG_WAIT',
          target: s.runId,
          message: `Tác vụ ${s.type} chờ/chạy quá 15 phút; không tự gửi lại AI.`,
        })),
        ...failed.map((s) => ({
          severity: 'warning',
          code: s.errorCode ?? 'STEP_FAILED',
          target: s.runId,
          message: s.error ?? 'Tác vụ lỗi trong giờ gần nhất.',
        })),
        ...Object.values(budgets)
          .filter((b) => b.usedPercent >= 80)
          .map((b) => ({
            severity: b.availableUsd <= 0 ? 'error' : 'warning',
            code: 'BUDGET_LOW',
            target: b.owner,
            message: `Đã dùng/giữ chỗ ${b.usedPercent.toFixed(0)}% hạn mức tuần.`,
          })),
        ...providers.items
          .filter((p) => p.status === 'error')
          .map((p) => ({
            severity: 'error',
            code: p.code ?? 'PROVIDER_UNAVAILABLE',
            target: p.id,
            message: p.message,
          })),
        ...(disk && disk.freeBytes / disk.totalBytes < 0.15
          ? [
              {
                severity: 'error',
                code: 'DISK_LOW',
                target: 'application',
                message: 'Ổ lưu trữ ứng dụng còn dưới 15% dung lượng.',
              },
            ]
          : []),
      ],
    };
  }
}
