import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../common/api-error';
import { AgentService } from './agent.service';
import { AgentStore } from './agent.store';
import { AIService } from '../ai/ai.service';
import type {
  Asset,
  Conversation,
  CustomWorkflow,
  Entity,
  Run,
  Step,
  WorkflowExecution,
} from './agent.types';

export type WorkflowInput = Pick<
  CustomWorkflow,
  'name' | 'description' | 'steps' | 'archived'
>;
export type LaunchWorkflow = Pick<
  WorkflowExecution,
  | 'conversationId'
  | 'brief'
  | 'sourceIds'
  | 'targetIds'
  | 'templateIds'
  | 'productType'
  | 'provider'
  | 'imageModel'
  | 'research'
  | 'researchSources'
  | 'validateVisually'
  | 'approvalMode'
> & { id: string };

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly store: AgentStore,
    private readonly agent: AgentService,
    private readonly ai: AIService,
  ) {}

  async save(
    owner: string,
    input: WorkflowInput,
    id?: string,
    updatedAt?: string,
  ) {
    if (input.steps[0].source === 'previous')
      throw new ApiError(
        400,
        'WORKFLOW_SOURCE_INVALID',
        'Bước đầu tiên phải sử dụng đầu vào ban đầu.',
      );
    if (!id)
      return this.store.insert(
        'workflow',
        this.store.create<CustomWorkflow>(owner, { ...input, revision: 1 }),
      );
    const previous = await this.store.get<CustomWorkflow>(
      'workflow',
      id,
      owner,
    );
    const updated = await this.store.patch<CustomWorkflow>(
      'workflow',
      id,
      owner,
      { ...input, revision: previous.revision + 1 },
      { updatedAt, revision: previous.revision },
    );
    if (!updated)
      throw new ApiError(
        409,
        'WORKFLOW_CHANGED',
        'Workflow đã thay đổi. Tải lại trước khi lưu.',
      );
    return updated;
  }

  async launch(
    owner: string,
    workflowId: string,
    input: LaunchWorkflow,
    requestId: string,
  ) {
    const existing = await this.store.find<WorkflowExecution>(
      'workflow-execution',
      input.id,
    );
    if (existing) {
      if (
        existing.owner !== owner ||
        existing.workflow.id !== workflowId ||
        existing.conversationId !== input.conversationId
      )
        throw new ApiError(
          409,
          'WORKFLOW_REQUEST_CONFLICT',
          'Mã chạy workflow đã được sử dụng.',
        );
      return this.stage(owner, existing.id, 0, requestId);
    }
    const workflow = await this.store.get<CustomWorkflow>(
      'workflow',
      workflowId,
      owner,
    );
    if (workflow.archived)
      throw new ApiError(409, 'WORKFLOW_ARCHIVED', 'Workflow đã được lưu trữ.');
    await this.store.get<Conversation>(
      'conversation',
      input.conversationId,
      owner,
    );
    for (const id of [...input.sourceIds, ...input.targetIds])
      await this.store.get<Asset>('asset', id, owner);
    for (const id of input.templateIds)
      await this.store.get<Entity>('template', id, owner);
    let previousCount = input.sourceIds.length;
    for (const step of workflow.steps) {
      const sources =
        step.source === 'previous' ? previousCount : input.sourceIds.length;
      if (step.operation !== 'design' && !sources)
        throw new ApiError(
          400,
          'WORKFLOW_SOURCE_REQUIRED',
          `Bước ${step.name} cần ảnh nguồn.`,
        );
      const targets =
        step.operation === 'mockup_ai'
          ? input.targetIds.length
          : input.templateIds.length;
      if (step.operation !== 'design' && !targets)
        throw new ApiError(
          400,
          'WORKFLOW_TARGET_REQUIRED',
          `Bước ${step.name} cần ảnh tham chiếu hoặc template.`,
        );
      previousCount =
        step.operation === 'design'
          ? Math.max(sources, 1) * step.count
          : sources * targets;
      if (previousCount > 20)
        throw new ApiError(
          400,
          'AGENT_BATCH_LIMIT',
          `Bước ${step.name} vượt 20 kết quả. Giảm đầu vào hoặc số biến thể.`,
        );
    }
    if (workflow.steps.some((step) => step.operation !== 'mockup_template')) {
      this.ai.validateSelection(input.provider, ['image']);
      await this.ai.validateImageModel(input.provider, input.imageModel);
    }
    const execution = this.store.create<WorkflowExecution>(owner, {
      conversationId: input.conversationId,
      workflow,
      brief: input.brief,
      approvalMode: input.approvalMode ?? 'manual',
      sourceIds: input.sourceIds,
      targetIds: input.targetIds,
      templateIds: input.templateIds,
      productType: input.productType,
      provider: input.provider,
      ...(input.imageModel ? { imageModel: input.imageModel } : {}),
      runIds: workflow.steps.map(() => randomUUID()),
      stage: 0,
      research: input.research,
      researchSources: input.researchSources,
      validateVisually: input.validateVisually,
    });
    execution.id = input.id;
    await this.store.ensure('workflow-execution', execution);
    const saved = await this.store.get<WorkflowExecution>(
      'workflow-execution',
      execution.id,
      owner,
    );
    if (
      saved.workflow.id !== workflowId ||
      saved.conversationId !== input.conversationId
    )
      throw new ApiError(
        409,
        'WORKFLOW_REQUEST_CONFLICT',
        'Mã chạy workflow đã được sử dụng.',
      );
    return this.stage(owner, execution.id, 0, requestId);
  }

  async stage(
    owner: string,
    id: string,
    index: number,
    requestId: string,
    approvalMode?: Run['approvalMode'],
  ) {
    const execution = await this.store.get<WorkflowExecution>(
      'workflow-execution',
      id,
      owner,
    );
    const step = execution.workflow.steps[index];
    if (!step || index > execution.stage + 1)
      throw new ApiError(
        409,
        'WORKFLOW_STAGE_INVALID',
        'Chưa thể chạy bước này.',
      );
    const existing = await this.store.find<Run>('run', execution.runIds[index]);
    if (existing) {
      if (
        existing.owner !== owner ||
        existing.workflow?.executionId !== execution.id ||
        existing.workflow.stage !== index
      )
        throw new ApiError(
          409,
          'WORKFLOW_REQUEST_CONFLICT',
          'Mã bước đã được sử dụng.',
        );
      await this.store.appendMessage(execution.conversationId, owner, {
        id: `${existing.id}:user`,
        role: 'user',
        text: existing.brief,
        createdAt: existing.createdAt,
        runId: existing.id,
      });
      await this.agent.ensureSteps(existing);
      const updated =
        index > execution.stage
          ? await this.store.patch<WorkflowExecution>(
              'workflow-execution',
              id,
              owner,
              { stage: index, approvalMode: existing.approvalMode ?? 'manual' },
              { stage: execution.stage },
            )
          : execution;
      return { execution: updated ?? execution, run: existing };
    }
    let sourceIds = execution.sourceIds;
    if (index > 0) {
      const previous = await this.store.get<Run>(
        'run',
        execution.runIds[index - 1],
        owner,
      );
      if (previous.state !== 'completed')
        throw new ApiError(
          409,
          'WORKFLOW_APPROVAL_REQUIRED',
          'Duyệt toàn bộ kết quả bước trước trước khi tiếp tục.',
        );
      const steps = await this.store.query<Step>(
        'step',
        { owner, runId: previous.id, type: 'image' },
        25,
      );
      const results = await Promise.all(
        steps
          .filter((item) => item.resultId)
          .map((item) => this.store.get<Asset>('asset', item.resultId, owner)),
      );
      if (
        results.length !== previous.count ||
        results.some((asset) => asset.review !== 'approved')
      )
        throw new ApiError(
          409,
          'WORKFLOW_APPROVAL_REQUIRED',
          'Kết quả bước trước chưa được duyệt đầy đủ.',
        );
      if (step.source === 'previous')
        sourceIds = results.map((asset) => asset.id);
    }
    const run = await this.agent.message(
      owner,
      execution.conversationId,
      {
        id: execution.runIds[index],
        text: `Workflow: ${execution.workflow.name}\nBước ${index + 1}/${execution.workflow.steps.length}: ${step.name}\nYêu cầu chung: ${execution.brief}\nHướng dẫn bước này: ${step.instructions}`,
        operation: step.operation,
        approvalMode: approvalMode ?? execution.approvalMode ?? 'manual',
        sourceIds,
        targetIds: step.operation === 'mockup_ai' ? execution.targetIds : [],
        templateIds:
          step.operation === 'mockup_template' ? execution.templateIds : [],
        count: step.count,
        provider: execution.provider,
        imageModel: execution.imageModel,
        productType: execution.productType,
        research: execution.research,
        researchSources: execution.researchSources,
        validateVisually: execution.validateVisually,
        workflow: {
          executionId: execution.id,
          name: execution.workflow.name,
          revision: execution.workflow.revision,
          stage: index,
          total: execution.workflow.steps.length,
        },
      },
      requestId,
    );
    const updated =
      index > execution.stage
        ? await this.store.patch<WorkflowExecution>(
            'workflow-execution',
            id,
            owner,
            { stage: index, approvalMode: run.approvalMode },
            { stage: execution.stage },
          )
        : execution;
    return {
      execution:
        updated ??
        (await this.store.get<WorkflowExecution>(
          'workflow-execution',
          id,
          owner,
        )),
      run,
    };
  }
  async replan(
    owner: string,
    id: string,
    input: { id: string; answer: string } & Partial<
      Pick<Run, 'sourceIds' | 'targetIds' | 'templateIds' | 'approvalMode'>
    >,
    requestId: string,
  ) {
    const execution = await this.store.get<WorkflowExecution>(
      'workflow-execution',
      id,
      owner,
    );
    const prior = await this.store.get<Run>(
      'run',
      execution.runIds[execution.stage],
      owner,
    );
    if (prior.id === input.id) return { execution, run: prior };
    const existing = await this.store.find<Run>('run', input.id);
    if (
      existing &&
      (existing.owner !== owner ||
        existing.workflow?.executionId !== id ||
        existing.workflow.stage !== execution.stage)
    )
      throw new ApiError(
        409,
        'WORKFLOW_REQUEST_CONFLICT',
        'Mã yêu cầu đã thuộc một công việc khác.',
      );
    if (
      !['needs_input', 'failed'].includes(prior.state) &&
      !(prior.state === 'draft' && prior.pendingInputs)
    )
      throw new ApiError(
        409,
        'WORKFLOW_REPLAN_INVALID',
        'Chỉ lập kế hoạch lại khi bước bị lỗi hoặc đang cần bổ sung.',
      );
    const text = `${prior.brief}\nThông tin bổ sung mới nhất: ${input.answer}`;
    if (text.length > 12000)
      throw new ApiError(
        400,
        'WORKFLOW_BRIEF_LIMIT',
        'Yêu cầu bổ sung quá dài. Hãy rút gọn hoặc tạo một phiên workflow mới.',
      );
    const run = await this.agent.message(
      owner,
      execution.conversationId,
      {
        ...prior,
        approvalMode: input.approvalMode ?? prior.approvalMode ?? 'manual',
        sourceIds:
          input.sourceIds ?? prior.pendingInputs?.sourceIds ?? prior.sourceIds,
        targetIds:
          input.targetIds ?? prior.pendingInputs?.targetIds ?? prior.targetIds,
        templateIds:
          input.templateIds ??
          prior.pendingInputs?.templateIds ??
          prior.templateIds,
        id: input.id,
        text,
        count: execution.workflow.steps[execution.stage].count,
      },
      requestId,
    );
    const runIds = [...execution.runIds];
    runIds[execution.stage] = run.id;
    const updated = await this.store.patch<WorkflowExecution>(
      'workflow-execution',
      id,
      owner,
      {
        runIds,
        approvalMode: input.approvalMode ?? execution.approvalMode ?? 'manual',
      },
      { stage: execution.stage, [`runIds.${execution.stage}`]: prior.id },
    );
    if (!updated) {
      const latest = await this.store.get<WorkflowExecution>(
        'workflow-execution',
        id,
        owner,
      );
      if (latest.runIds[execution.stage] === run.id)
        return { execution: latest, run };
      await this.agent.cancel(owner, run.id);
      throw new ApiError(
        409,
        'WORKFLOW_STAGE_CHANGED',
        'Bước đã thay đổi. Tải lại trước khi tiếp tục.',
      );
    }
    return { execution: updated, run };
  }
}
