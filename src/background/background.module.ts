import { Module } from '@nestjs/common';
import { AIModule } from '../ai/ai.module';
import { R2Module } from '../r2/r2.module';
import { BackgroundController } from './background.controller';
import { BackgroundService } from './background.service';

@Module({
  imports: [AIModule, R2Module],
  controllers: [BackgroundController],
  providers: [BackgroundService],
})
export class BackgroundModule {}
