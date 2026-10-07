import { Module } from '@nestjs/common';
import { IdeaService } from './idea.service';
import { IdeaController } from './idea.controller';
import { AIModule } from '../ai/ai.module';
import { R2Module } from '../r2/r2.module';

@Module({
  imports: [AIModule, R2Module],
  controllers: [IdeaController],
  providers: [IdeaService],
})
export class IdeaModule {}
