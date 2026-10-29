import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { AgentModule } from '../agent/agent.module';
import { TaskQueueModule } from '../queue/task-queue.module';
import { StudioController, StudioGuard } from './studio.controller';
import { StudioService } from './studio.service';
import { StudioLibraryService } from './studio-library.service';
import { StudioWorker } from './studio.worker';
import { StudioBundleService } from './studio-bundle.service';
import { StudioOperationsService } from './studio-operations.service';
import { StudioMockupService } from './studio-mockup.service';
import { StudioMockupWorker } from './studio-mockup.worker';
import { StudioMockupController } from './studio-mockup.controller';
import {
  StudioOperationsController,
  StudioTeamBudgetsController,
} from './studio-operations.controller';

@Module({
  imports: [AgentModule, AIModule, TaskQueueModule],
  controllers: [
    StudioController,
    StudioOperationsController,
    StudioTeamBudgetsController,
    StudioMockupController,
  ],
  providers: [
    StudioService,
    StudioLibraryService,
    StudioBundleService,
    StudioWorker,
    StudioGuard,
    StudioOperationsService,
    StudioMockupService,
    StudioMockupWorker,
  ],
})
export class StudioModule {}
