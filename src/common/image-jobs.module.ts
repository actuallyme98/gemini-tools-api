import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ImageJobsService } from './image-jobs.service';
import { AgentIdentityModule } from '../agent/agent-identity.module';
import { TaskQueueModule } from '../queue/task-queue.module';
import { ImageJobsWorker } from './image-jobs.worker';
import { AIModule } from '../ai/ai.module';
import { R2Module } from '../r2/r2.module';
import { BackgroundService } from '../background/background.service';
import { MockupService } from '../mockup/mockup.service';
import { IdeaService } from '../idea/idea.service';
import { AuditModule } from '../audit/audit.module';
import { ImageJobsController } from './image-jobs.controller';

@Module({
  imports: [
    ConfigModule,
    AgentIdentityModule,
    TaskQueueModule,
    AIModule,
    R2Module,
    AuditModule,
  ],
  controllers: [ImageJobsController],
  providers: [
    ImageJobsService,
    ImageJobsWorker,
    BackgroundService,
    MockupService,
    IdeaService,
  ],
  exports: [ImageJobsService],
})
export class ImageJobsModule {}
