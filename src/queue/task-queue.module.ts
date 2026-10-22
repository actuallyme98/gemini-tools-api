import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentIdentityModule } from '../agent/agent-identity.module';
import { TaskQueueService } from './task-queue.service';

@Global()
@Module({
  imports: [AgentIdentityModule, ConfigModule],
  providers: [TaskQueueService],
  exports: [TaskQueueService],
})
export class TaskQueueModule {}
