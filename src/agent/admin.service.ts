import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { AgentStore } from './agent.store';
import { AgentAuthService, publicUser } from './agent-auth.service';
import { AgentService } from './agent.service';
import { AuditLogService } from '../audit/audit-log.service';
import { AIService } from '../ai/ai.service';
import { ApiError } from '../common/api-error';
import { TaskQueueService } from '../queue/task-queue.service';
import { sanitizeErrorMessage } from '../common/error-sanitizer';
import { adminAction } from './admin-audit';
import {
  readAdminDiagnostics,
  type DiagnosticQuery,
} from './admin-diagnostics';
import type {
  AdminAudit,
  AgentUser,
  CompanySettings,
  Run,
  Step,
} from './agent.types';

export type AdminListQuery = {
  page: number;
  limit: number;
  search: string;
  role?: string;
  disabled?: boolean;
  state?: string;
  owner?: string;
};
export type UserChange = {
  updatedAt: string;
  reason: string;
  role?: AgentUser['role'];
  disabled?: boolean;
  password?: string;
  revokeSessions?: true;
};
const escapeRegex = (input: string) =>
  input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userView = (user: AgentUser) => ({
  ...publicUser(user),
  disabled: !!user.disabled,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  lastLoginAt: user.lastLoginAt,
  hasPassword: !!user.passwordHash,
  googleLinked: !!user.googleSub,
});

@Injectable()
export class AdminService {
  constructor(
    private readonly store: AgentStore,
    private readonly auth: AgentAuthService,
    private readonly agent: AgentService,
    private readonly audit: AuditLogService,
    private readonly ai: AIService,
    private readonly config: ConfigService,
    private readonly queue: TaskQueueService,
  ) {}
  private async company(actor: AgentUser) {
    if (
      !(await this.store.find<CompanySettings>('company-settings', 'company'))
    ) {
      const defaults = await this.auth.googleConfiguration();
      const record = this.store.create<CompanySettings>('', {
        name: 'LCG Media',
        protectedAdminId:
          (await this.store.firstAdministrator())?.id ?? actor.id,
        googleAllowedDomains: defaults.allowedDomains,
        googleAutoProvision: true,
        queuePaused: false,
      });
      record.id = 'company';
      await this.store.ensure('company-settings', record);
    }
    return await this.store.find<CompanySettings>(
      'company-settings',
      'company',
    );
  }
  async overview(actor: AgentUser) {
    const [snapshot, settings] = await Promise.all([
      this.store.adminSnapshot(),
      this.company(actor),
    ]);
    return {
      ...snapshot,
      queuePaused: settings.queuePaused,
      generatedAt: new Date().toISOString(),
      queue: await this.queue.metrics(),
    };
  }
  async users(actor: AgentUser, query: AdminListQuery) {
    const filters: Record<string, unknown> = {};
    if (query.search)
      filters.email = { $regex: escapeRegex(query.search), $options: 'i' };
    if (query.role) filters.role = query.role;
    if (query.disabled !== undefined)
      filters.disabled = query.disabled ? true : { $ne: true };
    const [result, settings] = await Promise.all([
      this.store.adminPage<AgentUser>('user', filters, query.page, query.limit),
      this.company(actor),
    ]);
    const usage = await this.store.adminUsage(
      result.items.map((user) => user.id),
    );
    return {
      ...result,
      protectedAdminId: settings.protectedAdminId,
      items: result.items.map((user) => ({
        ...userView(user),
        usage: Object.fromEntries(
          usage
            .filter((row) => row.owner === user.id)
            .map((row) => [row.kind, { count: row.count, bytes: row.bytes }]),
        ),
      })),
    };
  }
  async changeUser(actor: AgentUser, id: string, input: UserChange) {
    const [user, settings] = await Promise.all([
      this.store.find<AgentUser>('user', id),
      this.company(actor),
    ]);
    if (!user)
      throw new ApiError(404, 'AGENT_NOT_FOUND', 'Không tìm thấy tài khoản.');
    if (
      (id === settings.protectedAdminId || id === actor.id) &&
      ((input.role !== undefined && input.role !== 'admin') ||
        input.disabled === true)
    )
      throw new ApiError(
        409,
        'ADMIN_ACCOUNT_PROTECTED',
        'Không thể khóa hoặc hạ quyền quản trị viên gốc hay chính tài khoản đang sử dụng.',
      );
    const action = input.password
      ? 'account.password_reset'
      : input.revokeSessions
        ? 'account.sessions_revoked'
        : input.role
          ? 'account.role_changed'
          : input.disabled
            ? 'account.disabled'
            : 'account.enabled';
    return adminAction(
      this.store,
      actor,
      action,
      id,
      {
        reason: input.reason,
        email: user.email,
        ...(input.role ? { role: input.role } : {}),
        ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
      },
      async () => {
        const fields: Partial<AgentUser> = {
          authVersion: (user.authVersion ?? 0) + 1,
        };
        if (input.role) fields.role = input.role;
        if (input.disabled !== undefined) fields.disabled = input.disabled;
        if (input.password) {
          const salt = randomBytes(16).toString('hex');
          const hash = (await promisify(scrypt)(
            input.password,
            salt,
            64,
          )) as Buffer;
          fields.passwordHash = `${salt}:${hash.toString('hex')}`;
        }
        const updated = await this.store.patch<AgentUser>(
          'user',
          id,
          user.owner,
          fields,
          { updatedAt: input.updatedAt },
        );
        if (!updated)
          throw new ApiError(
            409,
            'ADMIN_RECORD_CHANGED',
            'Tài khoản đã thay đổi. Hãy tải lại trước khi tiếp tục.',
          );
        // authVersion already invalidates every old session; cleanup may wait for TTL.
        await this.store.revokeUserSessions(id).catch(() => undefined);
        return userView(updated);
      },
    );
  }
  async runs(query: AdminListQuery) {
    const fields: Record<string, unknown> = {};
    if (query.state) fields.state = query.state;
    if (query.owner) fields.owner = query.owner;
    // A request ID/run ID search is exact; no scan of private prompts.
    if (query.search) fields.id = query.search;
    const result = await this.store.adminPage<Run>(
      'run',
      fields,
      query.page,
      query.limit,
    );
    const owners = [...new Set(result.items.map((run) => run.owner))];
    const users = await this.store.query<AgentUser>(
      'user',
      { id: { $in: owners } },
      query.limit,
    );
    return {
      ...result,
      items: result.items.map((run) => ({
        id: run.id,
        owner: run.owner,
        ownerEmail:
          users.find((user) => user.id === run.owner)?.email ??
          'Tài khoản không còn tồn tại',
        conversationId: run.conversationId,
        state: run.state,
        operation: run.operation,
        count: run.count,
        provider: run.provider,
        imageModel: run.imageModel,
        productType: run.productType,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        requestId: run.requestId,
      })),
    };
  }
  async runSteps(id: string) {
    if (!(await this.store.find<Run>('run', id)))
      throw new ApiError(404, 'AGENT_NOT_FOUND', 'Không tìm thấy công việc.');
    return (await this.store.query<Step>('step', { runId: id }, 25)).map(
      (step) => ({
        id: step.id,
        index: step.index,
        type: step.type,
        state: step.state,
        error: step.error ? sanitizeErrorMessage(step.error) : undefined,
        errorCode: step.errorCode,
        requestId: step.requestId,
        durationMs: step.durationMs,
        startedAt: step.startedAt,
      }),
    );
  }
  async cancelRun(actor: AgentUser, id: string, reason: string) {
    const run = await this.store.find<Run>('run', id);
    if (!run)
      throw new ApiError(404, 'AGENT_NOT_FOUND', 'Không tìm thấy công việc.');
    return adminAction(
      this.store,
      actor,
      'run.cancelled',
      id,
      { reason, owner: run.owner },
      async () => {
        const result = await this.agent.cancel(run.owner, id);
        if (result.state !== 'cancelled')
          throw new ApiError(
            409,
            'ADMIN_RUN_FINISHED',
            'Công việc đã kết thúc; không còn tác vụ để dừng.',
          );
        return { id: result.id, state: result.state };
      },
    );
  }
  actions(query: AdminListQuery) {
    const fields: Record<string, unknown> = {};
    if (query.search)
      fields.action = { $regex: escapeRegex(query.search), $options: 'i' };
    if (query.owner) fields.owner = query.owner;
    return this.store.adminPage<AdminAudit>(
      'admin-audit',
      fields,
      query.page,
      query.limit,
    );
  }
  async diagnostics(query: DiagnosticQuery) {
    await this.audit.flush();
    return readAdminDiagnostics(this.audit.directory, query);
  }
  async settings(actor: AgentUser) {
    return {
      company: await this.company(actor),
      runtime: {
        queue: await this.queue.metrics(),
        agentEnabled: this.store.enabled,
        workerEnabled: this.config.get<boolean>('QUEUE_WORKER_ENABLED', true),
        concurrency: this.config.get<number>('AGENT_CONCURRENCY', 3),
        sessionHours: this.config.get<number>('AGENT_SESSION_HOURS', 24),
        googleConfigured: !!this.config.get<string>('GOOGLE_CLIENT_ID'),
        logRetentionDays: this.config.get<number>(
          'AUDIT_LOG_RETENTION_DAYS',
          7,
        ),
        logImageLimitBytes: this.config.get<number>(
          'AUDIT_IMAGE_MAX_BYTES_PER_DAY',
          536870912,
        ),
        assetEncryption: !!this.config.get<string>(
          'AGENT_ASSET_ENCRYPTION_KEY',
        ),
        storagePrefix: this.config.get<string>('R2_KEY_PREFIX', 'gemini-tools'),
        providers: this.ai.getProviders(),
      },
    };
  }
  async updateSettings(
    actor: AgentUser,
    input: Pick<
      CompanySettings,
      | 'name'
      | 'googleAllowedDomains'
      | 'googleAutoProvision'
      | 'queuePaused'
      | 'updatedAt'
    > & { reason: string },
  ) {
    const current = await this.company(actor);
    const { reason, updatedAt, ...fields } = input;
    return adminAction(
      this.store,
      actor,
      'company.settings_changed',
      'company',
      { reason, ...fields },
      async () => {
        const updated = await this.store.patch<CompanySettings>(
          'company-settings',
          'company',
          '',
          fields,
          { updatedAt },
        );
        if (!updated)
          throw new ApiError(
            409,
            'ADMIN_RECORD_CHANGED',
            'Cấu hình đã thay đổi. Hãy tải lại trước khi lưu.',
          );
        return { ...updated, protectedAdminId: current.protectedAdminId };
      },
    );
  }
}
