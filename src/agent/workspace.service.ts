import { Injectable } from '@nestjs/common';
import { AgentStore } from './agent.store';
import { AgentAssetsService } from './agent-assets.service';
import { ApiError } from '../common/api-error';
import type { AgentUser, Asset, Run, Step } from './agent.types';
import type { Project, ProjectRole, JobComment } from './workspace.types';
import type { BudgetAccount, BudgetPolicy } from './budget.types';
import { publicAsset } from './agent.service';

@Injectable()
export class WorkspaceService {
  constructor(
    readonly store: AgentStore,
    private readonly assets: AgentAssetsService,
  ) {}
  async projects(user: AgentUser) {
    return this.store.query<Project>(
      'project',
      user.role === 'admin' ? {} : { memberIds: user.id },
      200,
      -1,
    );
  }
  async project(
    user: AgentUser,
    id: string,
    allowed: ProjectRole[] = ['viewer', 'editor', 'reviewer', 'manager'],
  ) {
    const project = await this.store.find<Project>('project', id);
    const role =
      project?.owner === user.id || user.role === 'admin'
        ? 'manager'
        : project?.members.find((m) => m.id === user.id)?.role;
    if (!project || !role || !allowed.includes(role))
      throw new ApiError(
        403,
        'PROJECT_FORBIDDEN',
        'Bạn chưa có quyền thực hiện thao tác trong dự án này.',
      );
    return project;
  }
  async saveProject(
    user: AgentUser,
    id: string | undefined,
    input: {
      name: string;
      description: string;
      members: { email: string; role: ProjectRole }[];
      archived: boolean;
      updatedAt?: string;
    },
  ) {
    const previous = id ? await this.project(user, id, ['manager']) : undefined;
    const members: Project['members'] = [];
    for (const member of input.members) {
      const found = (
        await this.store.query<AgentUser>(
          'user',
          { email: member.email.toLowerCase(), disabled: { $ne: true } },
          1,
        )
      )[0];
      if (!found)
        throw new ApiError(
          400,
          'PROJECT_MEMBER_INVALID',
          'Thành viên phải là tài khoản công ty đang hoạt động.',
        );
      members.push({ id: found.id, email: found.email, role: member.role });
    }
    const owner = previous?.owner ?? user.id;
    const fields = {
      name: input.name,
      description: input.description,
      members,
      memberIds: [...new Set([owner, ...members.map((m) => m.id)])],
      archived: input.archived,
    };
    if (!previous)
      return this.store.insert(
        'project',
        this.store.create<Project>(owner, fields),
      );
    const saved = await this.store.patch<Project>(
      'project',
      previous.id,
      owner,
      fields,
      { updatedAt: input.updatedAt },
    );
    if (!saved)
      throw new ApiError(
        409,
        'PROJECT_CHANGED',
        'Dự án vừa thay đổi. Tải lại trước khi lưu.',
      );
    return saved;
  }
  async run(
    user: AgentUser,
    id: string,
    action: 'read' | 'comment' | 'review' | 'assign' = 'read',
  ) {
    const run = await this.store.find<Run>('run', id);
    if (!run)
      throw new ApiError(404, 'AGENT_NOT_FOUND', 'Không tìm thấy công việc.');
    if (
      action === 'review' &&
      run.reviewerId &&
      run.reviewerId !== user.id &&
      user.role !== 'admin'
    )
      throw new ApiError(
        403,
        'JOB_REVIEWER_REQUIRED',
        'Công việc đã chỉ định người duyệt khác.',
      );
    if (run.owner === user.id) return run;
    if (!run.projectId)
      throw new ApiError(
        403,
        'JOB_FORBIDDEN',
        'Công việc này chưa được chia sẻ với bạn.',
      );
    await this.project(
      user,
      run.projectId,
      action === 'read'
        ? ['viewer', 'editor', 'reviewer', 'manager']
        : action === 'review'
          ? ['reviewer', 'manager']
          : action === 'assign'
            ? ['manager']
            : ['editor', 'reviewer', 'manager'],
    );
    return run;
  }
  async jobs(
    user: AgentUser,
    page: number,
    state?: string,
    projectId?: string,
  ) {
    const projects = await this.projects(user);
    const accessible = projects.map((p) => p.id);
    if (projectId && !accessible.includes(projectId))
      throw new ApiError(
        403,
        'PROJECT_FORBIDDEN',
        'Bạn chưa có quyền xem dự án.',
      );
    const result = await this.store.workspaceRuns(
      user.id,
      accessible,
      page,
      state,
      projectId,
    );
    return {
      ...result,
      items: await Promise.all(
        result.items.map(async (run) => {
          const steps = await this.store.query<Step>(
            'step',
            { owner: run.owner, runId: run.id },
            25,
          );
          const imageSteps = steps.filter((s) => s.type === 'image');
          const completed = imageSteps.filter((s) => s.resultId).length;
          return {
            id: run.id,
            owner: run.owner,
            conversationId: run.conversationId,
            brief: run.brief,
            state: run.state,
            operation: run.operation,
            projectId: run.projectId,
            assigneeId: run.assigneeId,
            reviewerId: run.reviewerId,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            count: run.count,
            completed,
            progress: run.count ? Math.round((completed / run.count) * 100) : 0,
          };
        }),
      ),
    };
  }
  async costs(run: Run, steps: Step[]) {
    const [account, policy] = await Promise.all([
      this.store.find<BudgetAccount>('budget-account', run.owner),
      this.store.find<BudgetPolicy>('budget-policy', 'company'),
    ]);
    const scopes = new Set(steps.map((s) => s.id)),
      requests = new Set(steps.map((s) => s.requestId));
    const entries = Object.values(account?.periods ?? {})
      .flatMap((p) => Object.values(p.entries))
      .filter((e) =>
        e.scope ? scopes.has(e.scope) : requests.has(e.requestId),
      );
    return {
      currency: policy?.currency ?? 'USD',
      costUsd: entries.reduce((sum, e) => sum + (e.costMicro ?? 0), 0) / 1e6,
      reservedUsd:
        entries.reduce(
          (sum, e) => sum + (e.status !== 'settled' ? e.reservedMicro : 0),
          0,
        ) / 1e6,
      unresolved: entries.filter((e) => e.status !== 'settled').length,
      coverage: 'journalled_calls_only',
    };
  }
  async detail(user: AgentUser, id: string) {
    const run = await this.run(user, id);
    const steps = await this.store.query<Step>(
      'step',
      { runId: id, owner: run.owner },
      25,
    );
    const ids = [
      ...new Set([
        ...run.sourceIds,
        ...run.targetIds,
        ...steps.flatMap((s) => (s.resultId ? [s.resultId] : [])),
      ]),
    ];
    const assets = (
      await this.store.query<Asset>(
        'asset',
        { owner: run.owner, id: { $in: ids } },
        100,
      )
    ).map(publicAsset);
    const comments = await this.store.query<JobComment>(
      'job-comment',
      { runId: id },
      200,
      -1,
    );
    return { run, steps, assets, comments, cost: await this.costs(run, steps) };
  }
  private async accessibleAsset(
    user: AgentUser,
    runId: string,
    assetId: string,
  ) {
    const run = await this.run(user, runId);
    const asset = await this.store.get<Asset>('asset', assetId, run.owner);
    if (
      !run.sourceIds.includes(asset.id) &&
      !run.targetIds.includes(asset.id) &&
      asset.runId !== run.id
    )
      throw new ApiError(
        403,
        'JOB_ASSET_FORBIDDEN',
        'Ảnh không thuộc công việc được chia sẻ.',
      );
    return { owner: run.owner, assetId };
  }
  async asset(user: AgentUser, runId: string, assetId: string) {
    const access = await this.accessibleAsset(user, runId, assetId);
    return this.assets.read(access.owner, assetId);
  }
  async preview(user: AgentUser, runId: string, assetId: string) {
    const access = await this.accessibleAsset(user, runId, assetId);
    return this.assets.preview(access.owner, assetId);
  }
  async assign(
    user: AgentUser,
    id: string,
    input: {
      projectId?: string;
      assigneeId?: string;
      reviewerId?: string;
      updatedAt: string;
    },
  ) {
    const run = await this.run(user, id, 'assign');
    const project = input.projectId
      ? await this.project(user, input.projectId, ['manager'])
      : undefined;
    if (project?.archived)
      throw new ApiError(409, 'PROJECT_ARCHIVED', 'Dự án đã lưu trữ.');
    for (const memberId of [input.assigneeId, input.reviewerId].filter(
      Boolean,
    )) {
      if (!project?.memberIds.includes(memberId))
        throw new ApiError(
          400,
          'PROJECT_MEMBER_INVALID',
          'Người phụ trách/người duyệt phải thuộc dự án.',
        );
    }
    if (
      input.reviewerId &&
      project &&
      project.owner !== input.reviewerId &&
      !project.members.some(
        (m) =>
          m.id === input.reviewerId && ['reviewer', 'manager'].includes(m.role),
      )
    )
      throw new ApiError(
        400,
        'JOB_REVIEWER_REQUIRED',
        'Người duyệt cần quyền reviewer hoặc manager.',
      );
    const saved = await this.store.patch<Run>(
      'run',
      id,
      run.owner,
      {
        projectId: project?.id ?? '',
        assigneeId: input.assigneeId ?? '',
        reviewerId: input.reviewerId ?? '',
      },
      { updatedAt: input.updatedAt },
    );
    if (!saved)
      throw new ApiError(
        409,
        'JOB_CHANGED',
        'Công việc vừa thay đổi. Tải lại trước khi phân công.',
      );
    return saved;
  }
  async comment(
    user: AgentUser,
    id: string,
    input: { text: string; action: JobComment['action']; assetId?: string },
  ) {
    const run = await this.run(
      user,
      id,
      input.action === 'comment' ? 'comment' : 'review',
    );
    if (input.action !== 'comment' && !input.assetId)
      throw new ApiError(400, 'JOB_ASSET_REQUIRED', 'Chọn ảnh để duyệt.');
    const asset = input.assetId
      ? await this.store.get<Asset>('asset', input.assetId, run.owner)
      : undefined;
    if (asset && asset.runId !== run.id)
      throw new ApiError(
        403,
        'JOB_ASSET_FORBIDDEN',
        'Ảnh không phải kết quả của công việc.',
      );
    if (
      input.action !== 'comment' &&
      !['review', 'completed', 'partial_failed'].includes(run.state)
    )
      throw new ApiError(
        409,
        'JOB_NOT_REVIEWABLE',
        'Công việc chưa tới bước duyệt kết quả.',
      );
    const saved = await this.store.insert(
      'job-comment',
      this.store.create<JobComment>(user.id, {
        ...input,
        runId: run.id,
        authorEmail: user.email,
      }),
    );
    if (asset && input.action !== 'comment') {
      await this.store.patch<Asset>('asset', asset.id, run.owner, {
        review: input.action,
      });
      const results = await this.store.query<Asset>(
        'asset',
        { owner: run.owner, runId: id },
        25,
      );
      await this.store.patch<Run>(
        'run',
        id,
        run.owner,
        {
          state:
            results.length === run.count &&
            results.every((a) => a.review === 'approved')
              ? 'completed'
              : 'review',
        },
        { state: { $in: ['review', 'completed'] } },
      );
    }
    return saved;
  }
}
