import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { R2Module } from '../r2/r2.module';
import { AgentStore } from './agent.store';
import { AgentAuthService, AgentGuard } from './agent-auth.service';
import { AgentAssetsService } from './agent-assets.service';
import { AgentService } from './agent.service';
import { AgentWorker } from './agent.worker';
import { AgentAuthController, AgentController } from './agent.controller';

@Module({
  imports: [AIModule, R2Module],
  providers: [
    AgentStore,
    AgentAuthService,
    AgentGuard,
    AgentAssetsService,
    AgentService,
    AgentWorker,
  ],
  controllers: [AgentAuthController, AgentController],
})
export class AgentModule {}
