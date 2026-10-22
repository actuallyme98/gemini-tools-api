import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Query,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as Joi from 'joi';
import { randomUUID } from 'node:crypto';
import {
  AgentAuthService,
  AgentGuard,
  publicUser,
  type AgentRequest,
} from './agent-auth.service';
import { AgentStore } from './agent.store';
import { AgentService, publicAsset } from './agent.service';
import { AgentAssetsService } from './agent-assets.service';
import {
  editPlanSchema,
  idSchema,
  loginSchema,
  messageSchema,
  parse,
  startSchema,
  templateSchema,
  userSchema,
} from './agent.schemas';
import type {
  AgentUser,
  Asset,
  Conversation,
  Entity,
  MockupTemplate,
  Run,
  Step,
} from './agent.types';
import { ApiError } from '../common/api-error';
import { AgentDatabaseFilter } from './agent-database.filter';

@Controller('agent/auth')
@UseFilters(AgentDatabaseFilter)
export class AgentAuthController {
  constructor(
    private readonly auth: AgentAuthService,
    private readonly store: AgentStore,
  ) {}
  @Get('status') async status() {
    return {
      enabled: this.store.enabled,
      setupRequired:
        this.store.enabled &&
        !(await this.store.query<AgentUser>('user', {}, 1)).length,
    };
  }
  @Post('login') @HttpCode(200) login(
    @Body() body: unknown,
    @Req() req: AgentRequest,
  ) {
    const input = parse<{ email: string; password: string }>(loginSchema, body);
    return this.auth.login(input.email, input.password, req.ip ?? 'unknown');
  }
  @Get('me') @UseGuards(AgentGuard) me(@Req() req: AgentRequest) {
    return publicUser(req.agentUser);
  }
  @Post('logout') @HttpCode(204) @UseGuards(AgentGuard) async logout(
    @Req() req: AgentRequest,
  ) {
    await this.auth.logout(req.headers.authorization);
  }
  @Post('users') @UseGuards(AgentGuard) createUser(
    @Body() body: unknown,
    @Req() req: AgentRequest,
  ) {
    if (req.agentUser.role !== 'admin')
      throw new ApiError(
        403,
        'AGENT_ADMIN_REQUIRED',
        'Chỉ quản trị viên được tạo tài khoản.',
      );
    const input = parse<{
      email: string;
      password: string;
      role: AgentUser['role'];
    }>(userSchema, body);
    return this.auth.createUser(input.email, input.password, input.role);
  }
}

@Controller('agent')
@UseFilters(AgentDatabaseFilter)
@UseGuards(AgentGuard)
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly store: AgentStore,
    private readonly assets: AgentAssetsService,
  ) {}
  @Get('conversations') async conversations(@Req() req: AgentRequest) {
    return (
      await this.store.list<Conversation>('conversation', req.agentUser.id)
    ).map(({ messages: _messages, ...conversation }) => {
      void _messages;
      return conversation;
    });
  }
  @Post('conversations') create(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    const input = parse<{ title: string }>(
      Joi.object({
        title: Joi.string().trim().max(120).default('Công việc mới'),
      }),
      body,
    );
    return this.agent.createConversation(req.agentUser.id, input.title);
  }
  @Get('conversations/:id') detail(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Query('runId') runId?: string,
  ) {
    return this.agent.detail(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
      runId ? parse<string>(idSchema.required(), runId) : undefined,
    );
  }
  @Post('conversations/:id/messages') @HttpCode(202) message(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.agent.message(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
      parse<Parameters<AgentService['message']>[2]>(messageSchema, body),
      String(req.res?.getHeader('X-Request-Id') || randomUUID()),
    );
  }
  @Patch('runs/:id/plan') editPlan(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.agent.editPlan(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
      parse(editPlanSchema, body),
    );
  }
  @Post('runs/:id/start') @HttpCode(202) start(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.agent.start(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
      parse<{ updatedAt: string }>(startSchema, body).updatedAt,
    );
  }
  @Post('runs/:id/cancel') cancel(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.agent.cancel(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
    );
  }
  @Post('runs/:id/retry') retry(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<{ id: string; stepIds: string[] }>(
      Joi.object({
        id: idSchema.required(),
        stepIds: Joi.array()
          .items(Joi.string().pattern(/^[a-f0-9-]{36}:image:\d{1,2}$/))
          .unique()
          .min(1)
          .max(20)
          .required(),
      }),
      body,
    );
    return this.agent.retry(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
      input.stepIds,
      input.id,
    );
  }
  @Get('assets') async listAssets(@Req() req: AgentRequest) {
    return (await this.store.list<Asset>('asset', req.agentUser.id)).map(
      publicAsset,
    );
  }
  @Get('runs') async runs(@Req() req: AgentRequest) {
    const owner = req.agentUser.id;
    const runs = await this.store.list<Run>('run', owner);
    const active = await this.store.query<Step>('step', {
      owner,
      state: { $in: ['queued', 'running'] },
    });
    return runs.map((run) => ({
      id: run.id,
      conversationId: run.conversationId,
      state: run.state,
      activeStepCount: active.filter((step) => step.runId === run.id).length,
    }));
  }
  @Get('assets/:id/preview') async preview(
    @Req() req: AgentRequest,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    const buffer = await this.assets.preview(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
    );
    res
      .set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(buffer);
  }
  @Post('assets')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 5 },
    }),
  )
  async upload(
    @Req() req: AgentRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: unknown,
  ) {
    if (!file)
      throw new ApiError(
        400,
        'AGENT_IMAGE_REQUIRED',
        'Hãy chọn ảnh để tải lên.',
      );
    const input = parse<{
      kind: Asset['kind'];
      category: string;
      parentId?: string;
    }>(
      Joi.object({
        kind: Joi.string()
          .valid('source', 'reference', 'design', 'template')
          .required(),
        category: Joi.string().max(100).default('POD'),
        parentId: idSchema,
      }),
      body,
    );
    return publicAsset(
      await this.assets.save(req.agentUser.id, file.buffer, {
        ...input,
        name: file.originalname,
      }),
    );
  }
  @Get('assets/:id/content') async content(
    @Req() req: AgentRequest,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    const { asset, buffer } = await this.assets.read(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
    );
    res
      .set({
        'Content-Type': asset.mimeType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
      })
      .send(buffer);
  }
  @Patch('assets/:id/review') async review(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { review } = parse<{ review: Asset['review'] }>(
      Joi.object({
        review: Joi.string()
          .valid('draft', 'approved', 'changes_requested')
          .required(),
      }),
      body,
    );
    const asset = await this.store.get<Asset>(
      'asset',
      parse<string>(idSchema.required(), id),
      req.agentUser.id,
    );
    const updated = await this.store.patch<Asset>(
      'asset',
      asset.id,
      asset.owner,
      { review },
    );
    if (asset.runId) {
      const run = await this.store.get<Run>('run', asset.runId, asset.owner);
      if (['review', 'completed'].includes(run.state)) {
        const steps = await this.store.query<Step>(
          'step',
          { runId: run.id, type: 'image' },
          25,
        );
        const results = await Promise.all(
          steps
            .filter((step) => step.resultId)
            .map((step) =>
              this.store.get<Asset>('asset', step.resultId, asset.owner),
            ),
        );
        await this.store.patch<Run>(
          'run',
          run.id,
          run.owner,
          {
            state:
              results.length === run.count &&
              results.every((result) => result.review === 'approved')
                ? 'completed'
                : 'review',
          },
          { state: { $in: ['review', 'completed'] } },
        );
      }
    }
    return publicAsset(updated);
  }
  @Get('templates') templates(@Req() req: AgentRequest) {
    return this.store.list<MockupTemplate>('template', req.agentUser.id);
  }
  @Post('templates') createTemplate(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    return this.agent.createTemplate(
      req.agentUser.id,
      parse<Omit<MockupTemplate, keyof Entity | 'revision'>>(
        templateSchema,
        body,
      ),
    );
  }
}
