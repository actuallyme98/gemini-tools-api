import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import * as Joi from 'joi';
import { AgentGuard, type AgentRequest } from '../agent/agent-auth.service';
import { AgentDatabaseFilter } from '../agent/agent-database.filter';
import { parse, idSchema } from '../agent/agent.schemas';
import { StudioGuard } from './studio.controller';
import { StudioMockupService } from './studio-mockup.service';
import type { MockupInput } from './studio-mockup.types';
const identifier = (id: string) =>
  parse<string>(
    Joi.string()
      .pattern(/^[a-zA-Z0-9-]{1,150}$/)
      .required(),
    id,
  );
@Controller('agent/studio/mockups')
@UseFilters(AgentDatabaseFilter)
@UseGuards(AgentGuard, StudioGuard)
export class StudioMockupController {
  constructor(private readonly mockups: StudioMockupService) {}
  @Get() list(@Req() req: AgentRequest, @Query('page') page = '1') {
    return this.mockups.list(
      req.agentUser,
      parse<number>(
        Joi.number().integer().min(1).max(100000).required(),
        Number(page),
      ),
    );
  }
  @Get(':id') detail(@Req() req: AgentRequest, @Param('id') id: string) {
    return this.mockups.detail(req.agentUser, identifier(id));
  }
  @Post() create(@Req() req: AgentRequest, @Body() body: unknown) {
    const input = parse<MockupInput>(
      Joi.object({
        requestKey: idSchema.required(),
        title: Joi.string().trim().min(1).max(160).required(),
        storeId: idSchema.required(),
        productId: idSchema.required(),
        sources: Joi.array()
          .items(
            Joi.object({
              assetId: idSchema.required(),
              ticketId: Joi.string().pattern(/^[a-zA-Z0-9-]{1,150}$/),
              sceneIds: Joi.array()
                .items(idSchema)
                .unique()
                .min(1)
                .max(12)
                .required(),
              colors: Joi.array()
                .items(Joi.string().trim().max(60).allow(''))
                .unique()
                .min(1)
                .max(8)
                .required(),
            }),
          )
          .unique('assetId')
          .min(1)
          .max(12)
          .required(),
        provider: Joi.string().valid('shopaikey', 'gemini').required(),
        imageModel: Joi.string().trim().min(1).max(180).required(),
        instructions: Joi.string().max(8000).allow('').default(''),
      }),
      body,
    );
    return this.mockups.create(req.agentUser, input);
  }
  @Post(':id/cancel') cancel(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.mockups.change(req.agentUser, identifier(id), 'cancel');
  }
  @Post(':id/continue') resume(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.mockups.change(req.agentUser, identifier(id), 'continue');
  }
  @Post(':id/review') review(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<{
      assetId: string;
      decision: 'approved' | 'changes_requested';
      note: string;
    }>(
      Joi.object({
        assetId: idSchema.required(),
        decision: Joi.string()
          .valid('approved', 'changes_requested')
          .required(),
        note: Joi.string().trim().max(2000).allow('').default(''),
      }),
      body,
    );
    return this.mockups.review(
      req.agentUser,
      identifier(id),
      input.assetId,
      input.decision,
      input.note,
    );
  }
}
