import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { R2Module } from '../r2/r2.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { ProviderUsageService } from './provider-usage.service';
import { AgentAssetsService } from './agent-assets.service';
import { AgentService } from './agent.service';
import { AgentWorker } from './agent.worker';
import { AgentAuthController, AgentController } from './agent.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowsController } from './workflows.controller';
import { AgentIdentityModule } from './agent-identity.module';
import { TaskQueueModule } from '../queue/task-queue.module';

@Module({
  imports: [AIModule, R2Module, AgentIdentityModule, TaskQueueModule],
  providers: [
    AdminService,
    ProviderUsageService,
    AgentAssetsService,
    AgentService,
    AgentWorker,
    WorkflowsService,
  ],
  controllers: [
    AgentAuthController,
    AgentController,
    AdminController,
    WorkflowsController,
  ],
})
export class AgentModule {}
