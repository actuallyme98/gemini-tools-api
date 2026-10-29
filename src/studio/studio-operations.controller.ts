import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import * as Joi from 'joi';
import { ConfigService } from '@nestjs/config';
import {
  AgentAdminGuard,
  AgentGuard,
  type AgentRequest,
} from '../agent/agent-auth.service';
import { AgentDatabaseFilter } from '../agent/agent-database.filter';
import { idSchema, parse } from '../agent/agent.schemas';
import { BudgetService } from '../agent/budget.service';
import { budgetDay } from '../agent/team-budget.types';
import { StudioGuard } from './studio.controller';
import { StudioService } from './studio.service';
import { StudioOperationsService } from './studio-operations.service';

const uuid = (id: string) => parse<string>(idSchema.required(), id);
const identifier = (id: string) =>
  parse<string>(
    Joi.string()
      .pattern(/^[a-zA-Z0-9-]{1,150}$/)
      .required(),
    id,
  );
const pageNumber = (page?: string) =>
  parse<number>(
    Joi.number().integer().min(1).max(100000).required(),
    page === undefined ? 1 : Number(page),
  );

@Controller('agent/studio/team-budgets')
@UseGuards(AgentGuard, StudioGuard)
@UseFilters(AgentDatabaseFilter)
export class StudioTeamBudgetsController {
  constructor(
    private readonly studio: StudioService,
    private readonly budget: BudgetService,
  ) {}
  @Get(':id') async summary(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Query('day') day?: string,
  ) {
    await this.studio.team(req.agentUser, uuid(id), true);
    return this.budget.teamSummary(id, day ?? budgetDay().key);
  }
  @Patch(':id') @UseGuards(AgentAdminGuard) async limit(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.studio.team(req.agentUser, uuid(id), true);
    return this.budget.changeTeamLimit(
      req.agentUser,
      id,
      parse(
        Joi.object({
          dailyLimit: Joi.number().min(0).max(1000000).allow(null).required(),
          policyVersion: Joi.number().integer().min(0).required(),
          reason: Joi.string().trim().min(3).max(1000).required(),
        }),
        body,
      ),
    );
  }
  @Get(':id/entries') @UseGuards(AgentAdminGuard) async entries(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Query('day') day?: string,
    @Query('page') page?: string,
  ) {
    await this.studio.team(req.agentUser, uuid(id), true);
    return this.budget.teamEntries(
      id,
      day ?? budgetDay().key,
      pageNumber(page),
    );
  }
}
@Controller('agent/studio/operations')
@UseGuards(AgentGuard, AgentAdminGuard, StudioGuard)
@UseFilters(AgentDatabaseFilter)
export class StudioOperationsController {
  constructor(
    private readonly operations: StudioOperationsService,
    private readonly config: ConfigService,
    private readonly studio: StudioService,
  ) {}
  @Get('schedule') schedule() {
    return this.studio.schedule();
  }
  @Patch('schedule') changeSchedule(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    return this.studio.changeSchedule(
      req.agentUser,
      parse(
        Joi.object({
          dailyTime: Joi.string()
            .pattern(/^([01]\d|2[0-3]):[0-5]\d$/)
            .required(),
          revision: Joi.number().integer().min(0).required(),
          reason: Joi.string().trim().min(3).max(1000).required(),
        }),
        body,
      ),
    );
  }
  @Get('batches') async batches(@Query('page') page?: string) {
    return {
      ...(await this.operations.batches(pageNumber(page))),
      schedulerEnabled: this.config.get<boolean>(
        'STUDIO_SCHEDULER_ENABLED',
        false,
      ),
    };
  }
  @Get('batches/:id') batch(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Query('page') page?: string,
  ) {
    return this.operations.batch(
      req.agentUser,
      identifier(id),
      pageNumber(page),
    );
  }
  @Get('tickets/:id') ticket(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.operations.tasks(req.agentUser, identifier(id));
  }
  @Post('tickets/:id/resume-budget') resume(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.operations.resumeBudget(
      req.agentUser,
      identifier(id),
      parse<{ reason: string }>(
        Joi.object({ reason: Joi.string().trim().min(3).max(1000).required() }),
        body,
      ).reason,
    );
  }
}
