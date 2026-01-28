import { Module } from '@nestjs/common';
import { MockupService } from './mockup.service';
import { MockupController } from './mockup.controller';
import { ChatGPTModule } from '../chatgpt/chatgpt.module';
import { GeminiModule } from '../gemini/gemini.module';
import { R2Module } from '../r2/r2.module';

@Module({
  imports: [ChatGPTModule, GeminiModule, R2Module],
  controllers: [MockupController],
  providers: [MockupService],
})
export class MockupModule {}
