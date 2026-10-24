import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import * as Joi from 'joi';
import { AgentGuard, type AgentRequest } from './agent-auth.service';
import { AgentDatabaseFilter } from './agent-database.filter';
import { idSchema, parse } from './agent.schemas';
import { WorkspaceService } from './workspace.service';
import type { ProjectRole, JobComment, Knowledge } from './workspace.types';
import { ApiError } from '../common/api-error';

const id = (value: string) => parse<string>(idSchema.required(), value);
const projectInput = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().max(2000).allow('').default(''),
  members: Joi.array()
    .items(
      Joi.object({
        email: Joi.string().email().max(254).required(),
        role: Joi.string()
          .valid('viewer', 'editor', 'reviewer', 'manager')
          .required(),
      }),
    )
    .max(100)
    .unique('email')
    .default([]),
  archived: Joi.boolean().default(false),
});
type ProjectInput = {
  name: string;
  description: string;
  members: { email: string; role: ProjectRole }[];
  archived: boolean;
  updatedAt?: string;
};
const knowledgeInput = Joi.object({
  title: Joi.string().trim().min(1).max(160).required(),
  content: Joi.string().trim().min(1).max(50000).required(),
  tags: Joi.array()
    .items(Joi.string().trim().max(60))
    .max(20)
    .unique()
    .default([]),
  visibility: Joi.string().valid('private', 'company', 'project').required(),
  projectId: idSchema,
  archived: Joi.boolean().default(false),
});

@Controller('agent/workspace')
@UseGuards(AgentGuard)
@UseFilters(AgentDatabaseFilter)
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}
  @Header('Cache-Control', 'no-store') @Get('projects') projects(
    @Req() req: AgentRequest,
  ) {
    return this.workspace.projects(req.agentUser);
  }
  @Post('projects') createProject(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    return this.workspace.saveProject(
      req.agentUser,
      undefined,
      parse<ProjectInput>(projectInput, body),
    );
  }
  @Patch('projects/:id') updateProject(
    @Req() req: AgentRequest,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    return this.workspace.saveProject(
      req.agentUser,
      id(value),
      parse<ProjectInput>(
        projectInput.keys({ updatedAt: Joi.string().isoDate().required() }),
        body,
      ),
    );
  }
  @Header('Cache-Control', 'no-store') @Get('jobs') jobs(
    @Req() req: AgentRequest,
    @Query() query: unknown,
  ) {
    const input = parse<{ page: string; state?: string; projectId?: string }>(
      Joi.object({
        page: Joi.string()
          .pattern(/^[1-9]\d{0,5}$/)
          .default('1'),
        state: Joi.string().valid(
          'planning',
          'needs_input',
          'draft',
          'queued',
          'running',
          'review',
          'completed',
          'partial_failed',
          'failed',
          'cancelled',
        ),
        projectId: idSchema,
      }),
      query,
    );
    return this.workspace.jobs(
      req.agentUser,
      Number(input.page),
      input.state,
      input.projectId,
    );
  }
  @Header('Cache-Control', 'no-store') @Get('jobs/:id') detail(
    @Req() req: AgentRequest,
    @Param('id') value: string,
  ) {
    return this.workspace.detail(req.agentUser, id(value));
  }
  @Patch('jobs/:id/assignment') assign(
    @Req() req: AgentRequest,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    return this.workspace.assign(
      req.agentUser,
      id(value),
      parse(
        Joi.object({
          projectId: idSchema,
          assigneeId: idSchema,
          reviewerId: idSchema,
          updatedAt: Joi.string().isoDate().required(),
        }),
        body,
      ),
    );
  }
  @Post('jobs/:id/comments') comment(
    @Req() req: AgentRequest,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    return this.workspace.comment(
      req.agentUser,
      id(value),
      parse<{ text: string; action: JobComment['action']; assetId?: string }>(
        Joi.object({
          text: Joi.string().trim().min(1).max(4000).required(),
          action: Joi.string()
            .valid('comment', 'approved', 'changes_requested')
            .default('comment'),
          assetId: idSchema,
        }),
        body,
      ),
    );
  }
  @Header('Cache-Control', 'no-store')
  @Get('jobs/:id/assets/:assetId')
  async content(
    @Req() req: AgentRequest,
    @Param('id') value: string,
    @Param('assetId') assetId: string,
    @Res() res: Response,
    @Query('preview') preview?: string,
  ) {
    if (preview === '1') {
      const buffer = await this.workspace.preview(
        req.agentUser,
        id(value),
        id(assetId),
      );
      res
        .set({
          'Content-Type': 'image/webp',
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        .send(buffer);
      return;
    }
    const { buffer, asset } = await this.workspace.asset(
      req.agentUser,
      id(value),
      id(assetId),
    );
    res
      .set({
        'Content-Type': asset.mimeType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(buffer);
  }
  @Header('Cache-Control', 'no-store') @Get('knowledge') async knowledge(
    @Req() req: AgentRequest,
  ) {
    const projects = await this.workspace.projects(req.agentUser);
    return this.workspace.store.visibleKnowledge(
      req.agentUser.id,
      projects.map((p) => p.id),
    );
  }
  private async validateKnowledge(
    req: AgentRequest,
    input: Omit<
      Knowledge,
      'id' | 'owner' | 'createdAt' | 'updatedAt' | 'revision'
    >,
  ) {
    if (input.visibility === 'company' && req.agentUser.role !== 'admin')
      throw new ApiError(
        403,
        'KNOWLEDGE_ADMIN_REQUIRED',
        'Chỉ admin được công bố kiến thức cho toàn công ty.',
      );
    if (input.visibility === 'project') {
      if (!input.projectId)
        throw new ApiError(
          400,
          'PROJECT_REQUIRED',
          'Chọn dự án chia sẻ kiến thức.',
        );
      await this.workspace.project(req.agentUser, input.projectId, [
        'manager',
        'editor',
      ]);
    }
  }
  @Post('knowledge') async createKnowledge(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    const input = parse<
      Omit<Knowledge, 'id' | 'owner' | 'createdAt' | 'updatedAt' | 'revision'>
    >(knowledgeInput, body);
    await this.validateKnowledge(req, input);
    return this.workspace.store.insert(
      'knowledge',
      this.workspace.store.create<Knowledge>(req.agentUser.id, {
        ...input,
        revision: 1,
      }),
    );
  }
  @Patch('knowledge/:id') async updateKnowledge(
    @Req() req: AgentRequest,
    @Param('id') value: string,
    @Body() body: unknown,
  ) {
    const input = parse<
      Omit<Knowledge, 'id' | 'owner' | 'createdAt' | 'revision'>
    >(
      knowledgeInput.keys({ updatedAt: Joi.string().isoDate().required() }),
      body,
    );
    const previous = await this.workspace.store.find<Knowledge>(
      'knowledge',
      id(value),
    );
    if (
      !previous ||
      (previous.owner !== req.agentUser.id && req.agentUser.role !== 'admin')
    )
      throw new ApiError(
        403,
        'KNOWLEDGE_FORBIDDEN',
        'Chỉ tác giả hoặc admin được sửa tài liệu.',
      );
    await this.validateKnowledge(req, input);
    const saved = await this.workspace.store.patch<Knowledge>(
      'knowledge',
      previous.id,
      previous.owner,
      { ...input, revision: previous.revision + 1 },
      { updatedAt: input.updatedAt },
    );
    if (!saved)
      throw new ApiError(
        409,
        'KNOWLEDGE_CHANGED',
        'Tài liệu vừa thay đổi, hãy tải lại.',
      );
    return saved;
  }
}
