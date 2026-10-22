import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentStore } from './agent.store';
import {
  AgentAuthService,
  AgentGuard,
  AgentAdminGuard,
} from './agent-auth.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [AgentStore, AgentAuthService, AgentGuard, AgentAdminGuard],
  exports: [AgentStore, AgentAuthService, AgentGuard, AgentAdminGuard],
})
export class AgentIdentityModule {}
