import { Module } from '@nestjs/common';
import { IdeaService } from './idea.service';
import { IdeaController } from './idea.controller';
import { AIModule } from '../ai/ai.module';
import { R2Module } from '../r2/r2.module';
import { ImageJobsModule } from '../common/image-jobs.module';

@Module({
  imports: [AIModule, R2Module, ImageJobsModule],
  controllers: [IdeaController],
  providers: [IdeaService],
})
export class IdeaModule {}
