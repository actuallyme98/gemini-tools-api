import { Module } from '@nestjs/common';
import { MockupService } from './mockup.service';
import { MockupController } from './mockup.controller';
import { AIModule } from '../ai/ai.module';
import { R2Module } from '../r2/r2.module';
import { ImageJobsModule } from '../common/image-jobs.module';

@Module({
  imports: [AIModule, R2Module, ImageJobsModule],
  controllers: [MockupController],
  providers: [MockupService],
})
export class MockupModule {}
