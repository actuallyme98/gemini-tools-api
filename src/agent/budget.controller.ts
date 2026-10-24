import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import * as Joi from 'joi';
import {
  AgentGuard,
  AgentAdminGuard,
  type AgentRequest,
} from './agent-auth.service';
import { AgentDatabaseFilter } from './agent-database.filter';
import { BudgetService } from './budget.service';
import { PricingCatalogService } from './pricing-catalog.service';
import { idSchema, parse } from './agent.schemas';
import type { PriceRule } from './budget.types';
const amount = Joi.number()
  .min(0)
  .max(1000000)
  .custom((value: number, helpers) =>
    Math.abs(value * 100 - Math.round(value * 100)) < 0.00001
      ? value
      : helpers.error('number.precision'),
  );
const priceAmount = Joi.number().min(0).max(1000000).precision(6).strict();
const reason = Joi.string().trim().min(3).max(500).required();
const rule = Joi.object({
  provider: Joi.string().valid('shopaikey', 'gemini', 'vyceai').required(),
  model: Joi.string().trim().min(1).max(180).required(),
  operation: Joi.string().valid('text', 'vision', 'image', 'health').required(),
  reserveUsd: priceAmount.greater(0).required(),
  requestUsd: priceAmount,
  inputUsdPerMillion: priceAmount,
  outputUsdPerMillion: priceAmount,
  imageUsd: priceAmount,
  source: Joi.string().trim().min(3).max(500).required(),
})
  .and('inputUsdPerMillion', 'outputUsdPerMillion')
  .custom((value: PriceRule, helpers) =>
    value.operation !== 'image' && value.imageUsd !== undefined
      ? helpers.error('any.invalid')
      : value,
  );

@Controller('agent/usage')
@UseGuards(AgentGuard)
@UseFilters(AgentDatabaseFilter)
export class UsageController {
  constructor(private readonly budget: BudgetService) {}
  @Get() @Header('Cache-Control', 'no-store') async usage(
    @Req() req: AgentRequest,
  ) {
    return (await this.budget.summaries([req.agentUser.id]))[req.agentUser.id];
  }
}

@Controller('agent/admin')
@UseGuards(AgentGuard, AgentAdminGuard)
@UseFilters(AgentDatabaseFilter)
export class BudgetAdminController {
  constructor(
    private readonly budget: BudgetService,
    private readonly pricing: PricingCatalogService,
  ) {}
  @Get('pricing-catalog') @Header('Cache-Control', 'no-store') catalog() {
    return this.pricing.catalog();
  }
  @Get('pricing-readiness') @Header('Cache-Control', 'no-store') readiness() {
    return this.pricing.readiness();
  }
  @Get('budget-policy') @Header('Cache-Control', 'no-store') policy() {
    return this.budget.policy();
  }
  @Patch('budget-policy') updatePolicy(
    @Req() req: AgentRequest,
    @Body() body: unknown,
  ) {
    return this.budget.changePolicy(
      req.agentUser,
      parse<{
        currency?: 'USD' | 'CREDIT';
        defaultWeeklyUsd: number;
        prices: PriceRule[];
        updatedAt: string;
        reason: string;
      }>(
        Joi.object({
          currency: Joi.string().valid('USD', 'CREDIT'),
          defaultWeeklyUsd: amount.required(),
          prices: Joi.array()
            .items(rule)
            .max(200)
            .unique(
              (a: PriceRule, b: PriceRule) =>
                a.provider === b.provider &&
                a.model === b.model &&
                a.operation === b.operation,
            )
            .required(),
          updatedAt: Joi.string().isoDate().required(),
          reason,
        }),
        body,
      ),
    );
  }
  @Get('users/:id/usage') @Header('Cache-Control', 'no-store') usage(
    @Param('id') id: string,
    @Query('period') period?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.budget.details(
      parse<string>(idSchema.required(), id),
      period,
      cursor === undefined ? 0 : Number(cursor),
    );
  }
  @Patch('users/:id/budget') limit(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.budget.changeLimit(
      req.agentUser,
      parse<string>(idSchema.required(), id),
      parse<{
        weeklyUsd: number | null;
        policyVersion: number;
        reason: string;
      }>(
        Joi.object({
          weeklyUsd: amount.allow(null).required(),
          policyVersion: Joi.number().integer().min(0).required(),
          reason,
        }),
        body,
      ),
    );
  }
  @Patch('users/:id/usage/:period/:entry') reconcile(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Param('period') period: string,
    @Param('entry') entry: string,
    @Body() body: unknown,
  ) {
    return this.budget.reconcile(
      req.agentUser,
      parse<string>(idSchema.required(), id),
      parse<string>(
        Joi.string()
          .pattern(/^\d{4}-\d{2}-\d{2}$/)
          .required(),
        period,
      ),
      parse<string>(
        Joi.string()
          .pattern(/^[a-f0-9]{64}$/)
          .required(),
        entry,
      ),
      parse<{ costUsd: number; reason: string }>(
        Joi.object({ costUsd: priceAmount.required(), reason }),
        body,
      ),
    );
  }
}
