import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { AgentStore } from './agent.store';
import { BudgetService } from './budget.service';
import { UsageController, BudgetAdminController } from './budget.controller';
import {
  AgentAuthService,
  AgentGuard,
  AgentAdminGuard,
} from './agent-auth.service';

@Global()
@Module({
  imports: [ConfigModule, AuditModule],
  controllers: [UsageController, BudgetAdminController],
  providers: [
    AgentStore,
    AgentAuthService,
    AgentGuard,
    AgentAdminGuard,
    BudgetService,
  ],
  exports: [
    AgentStore,
    AgentAuthService,
    AgentGuard,
    AgentAdminGuard,
    BudgetService,
  ],
})
export class AgentIdentityModule {}
