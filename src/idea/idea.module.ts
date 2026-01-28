import { Module } from '@nestjs/common';
import { IdeaService } from './idea.service';
import { IdeaController } from './idea.controller';
import { ChatGPTModule } from '../chatgpt/chatgpt.module';
import { GeminiModule } from '../gemini/gemini.module';
import { R2Module } from '../r2/r2.module';

@Module({
  imports: [ChatGPTModule, GeminiModule, R2Module],
  controllers: [IdeaController],
  providers: [IdeaService],
})
export class IdeaModule {}
