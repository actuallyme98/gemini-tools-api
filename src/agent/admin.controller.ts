import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import * as Joi from 'joi';
import {
  AgentAdminGuard,
  AgentAuthService,
  AgentGuard,
  type AgentRequest,
} from './agent-auth.service';
import { AgentDatabaseFilter } from './agent-database.filter';
import {
  AdminService,
  type AdminListQuery,
  type UserChange,
} from './admin.service';
import { idSchema, parse, userSchema } from './agent.schemas';
import type { DiagnosticQuery } from './admin-diagnostics';
import { ApiError } from '../common/api-error';

const reason = Joi.string().trim().min(3).max(500).required();
const listSchema = Joi.object({
  page: Joi.number().integer().min(1).max(2000).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
  search: Joi.string().trim().max(254).allow('').default(''),
  role: Joi.string().valid('admin', 'designer'),
  disabled: Joi.boolean(),
  owner: idSchema,
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
});
function list(query: unknown) {
  const result = listSchema.validate(query, {
    convert: true,
    allowUnknown: false,
  });
  if (result.error)
    throw new ApiError(
      400,
      'AGENT_INPUT_INVALID',
      result.error.details[0].message,
    );
  return result.value as AdminListQuery;
}
@Controller('agent/admin')
@UseFilters(AgentDatabaseFilter)
@UseGuards(AgentGuard, AgentAdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly auth: AgentAuthService,
  ) {}
  @Get('overview') @Header('Cache-Control', 'no-store') overview(
    @Req() req: AgentRequest,
  ) {
    return this.admin.overview(req.agentUser);
  }
  @Get('users') @Header('Cache-Control', 'no-store') users(
    @Req() req: AgentRequest,
    @Query() query: unknown,
  ) {
    return this.admin.users(req.agentUser, list(query));
  }
  @Post('users') createUser(@Req() req: AgentRequest, @Body() body: unknown) {
    const input = parse<{
      email: string;
      password: string;
      role: 'admin' | 'designer';
    }>(userSchema, body);
    return this.auth.createUser(
      input.email,
      input.password,
      input.role,
      req.agentUser,
    );
  }
  @Patch('users/:id') changeUser(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.admin.changeUser(
      req.agentUser,
      parse<string>(idSchema.required(), id),
      parse<UserChange>(
        Joi.object({
          updatedAt: Joi.string().isoDate().required(),
          reason,
          role: Joi.string().valid('admin', 'designer'),
          disabled: Joi.boolean(),
          password: Joi.string().min(12).max(128),
          revokeSessions: Joi.boolean().valid(true),
        }).xor('role', 'disabled', 'password', 'revokeSessions'),
        body,
      ),
    );
  }
  @Get('runs') @Header('Cache-Control', 'no-store') runs(
    @Query() query: unknown,
  ) {
    return this.admin.runs(list(query));
  }
  @Get('runs/:id/steps') @Header('Cache-Control', 'no-store') steps(
    @Param('id') id: string,
  ) {
    return this.admin.runSteps(parse<string>(idSchema.required(), id));
  }
  @Post('runs/:id/cancel') @HttpCode(200) cancel(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.admin.cancelRun(
      req.agentUser,
      parse<string>(idSchema.required(), id),
      parse<{ reason: string }>(Joi.object({ reason }), body).reason,
    );
  }
  @Get('audit') @Header('Cache-Control', 'no-store') actions(
    @Query() query: unknown,
  ) {
    return this.admin.actions(list(query));
  }
  @Get('diagnostics') @Header('Cache-Control', 'no-store') diagnostics(
    @Query() query: unknown,
  ) {
    const schema = Joi.object({
      day: Joi.string()
        .pattern(/^\d{4}-\d{2}-\d{2}$/)
        .required(),
      cursor: Joi.number().integer().min(0).max(1000000).default(0),
      limit: Joi.number().integer().min(1).max(100).default(50),
      search: Joi.string().trim().max(254).allow('').default(''),
      errorsOnly: Joi.boolean().default(false),
    });
    const result = schema.validate(query, {
      convert: true,
      allowUnknown: false,
    });
    if (result.error)
      throw new ApiError(
        400,
        'AGENT_INPUT_INVALID',
        result.error.details[0].message,
      );
    return this.admin.diagnostics(result.value as DiagnosticQuery);
  }
  @Get('settings') @Header('Cache-Control', 'no-store') settings(
    @Req() req: AgentRequest,
  ) {
    return this.admin.settings(req.agentUser);
  }
  @Patch('settings') updateSettings(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    return this.admin.updateSettings(
      req.agentUser,
      parse<Parameters<AdminService['updateSettings']>[1]>(
        Joi.object({
          updatedAt: Joi.string().isoDate().required(),
          reason,
          name: Joi.string().trim().min(2).max(100).required(),
          googleAllowedDomains: Joi.array()
            .items(
              Joi.string()
                .lowercase()
                .pattern(
                  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
                ),
            )
            .max(50)
            .unique()
            .required(),
          googleAutoProvision: Joi.boolean().required(),
          queuePaused: Joi.boolean().required(),
        }),
        body,
      ),
    );
  }
}
