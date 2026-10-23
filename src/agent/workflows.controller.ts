import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import * as Joi from 'joi';
import { randomUUID } from 'node:crypto';
import { AgentGuard, type AgentRequest } from './agent-auth.service';
import { AgentDatabaseFilter } from './agent-database.filter';
import { idSchema, parse } from './agent.schemas';
import { AgentStore } from './agent.store';
import {
  WorkflowsService,
  type WorkflowInput,
  type LaunchWorkflow,
} from './workflows.service';
import type { CustomWorkflow } from './agent.types';

const workflowSchema = Joi.object({
  name: Joi.string().trim().min(3).max(120).required(),
  description: Joi.string().trim().allow('').max(1000).required(),
  archived: Joi.boolean().required(),
  steps: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().min(1).max(100).required(),
        operation: Joi.string()
          .valid('design', 'mockup_ai', 'mockup_template')
          .required(),
        instructions: Joi.string().trim().min(3).max(6000).required(),
        source: Joi.string().valid('initial', 'previous').required(),
        count: Joi.number().integer().min(1).max(20).required(),
      }),
    )
    .min(1)
    .max(8)
    .required(),
});
const ids = Joi.array().items(idSchema).max(20).unique().required();

@Controller('agent')
@UseFilters(AgentDatabaseFilter)
@UseGuards(AgentGuard)
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly store: AgentStore,
  ) {}
  @Get('workflows') list(@Req() req: AgentRequest) {
    return this.store.list<CustomWorkflow>('workflow', req.agentUser.id);
  }
  @Post('workflows') create(@Req() req: AgentRequest, @Body() body: unknown) {
    return this.workflows.save(
      req.agentUser.id,
      parse<WorkflowInput>(workflowSchema, body),
    );
  }
  @Patch('workflows/:id') update(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { updatedAt, ...input } = parse<
      WorkflowInput & { updatedAt: string }
    >(
      workflowSchema.keys({ updatedAt: Joi.string().isoDate().required() }),
      body,
    );
    return this.workflows.save(
      req.agentUser.id,
      input,
      parse<string>(idSchema.required(), id),
      updatedAt,
    );
  }
  @Post('workflows/:id/launch') launch(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<LaunchWorkflow>(
      Joi.object({
        id: idSchema.required(),
        conversationId: idSchema.required(),
        brief: Joi.string().trim().min(3).max(4000).required(),
        sourceIds: ids,
        targetIds: ids,
        templateIds: ids,
        productType: Joi.string().trim().min(1).max(100).required(),
        provider: Joi.string().valid('shopaikey', 'gemini').required(),
        imageModel: Joi.string().trim().max(180),
        research: Joi.string().max(20000).allow('').default(''),
        researchSources: Joi.array()
          .items(
            Joi.object({
              title: Joi.string().max(200).required(),
              url: Joi.string()
                .uri({ scheme: ['https', 'http'] })
                .max(2048)
                .required(),
              retrievedAt: Joi.string().isoDate().required(),
            }),
          )
          .max(20)
          .default([]),
        validateVisually: Joi.boolean().default(true),
        approvalMode: Joi.string().valid('manual', 'auto').default('manual'),
      }),
      body,
    );
    return this.workflows.launch(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
      input,
      String(req.res?.getHeader('X-Request-Id') || randomUUID()),
    );
  }
  @Post('workflow-executions/:id/stages/:stage') stage(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Param('stage') stage: string,
    @Body() body: unknown,
  ) {
    const input = parse<{ approvalMode?: 'manual' | 'auto' }>(
      Joi.object({
        approvalMode: Joi.string().valid('manual', 'auto'),
      }).default({}),
      body,
    );
    const index = parse<number>(
      Joi.number().integer().min(0).max(7).required(),
      Number(stage),
    );
    return this.workflows.stage(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
      index,
      String(req.res?.getHeader('X-Request-Id') || randomUUID()),
      input.approvalMode,
    );
  }
  @Post('workflow-executions/:id/replan') replan(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<Parameters<WorkflowsService['replan']>[2]>(
      Joi.object({
        id: idSchema.required(),
        answer: Joi.string().trim().min(3).max(12000).required(),
        approvalMode: Joi.string().valid('manual', 'auto'),
        sourceIds: Joi.array().items(idSchema).max(20).unique(),
        targetIds: Joi.array().items(idSchema).max(20).unique(),
        templateIds: Joi.array().items(idSchema).max(20).unique(),
      }),
      body,
    );
    return this.workflows.replan(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
      input,
      String(req.res?.getHeader('X-Request-Id') || randomUUID()),
    );
  }
}
