import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeminiModule } from '../gemini/gemini.module';
import { GeminiService } from '../gemini/gemini.service';
import { AI_PROVIDERS } from './ai-provider';
import { AIService } from './ai.service';
import { VyceAIProvider } from './providers/vyceai.provider';
import { ShopAIKeyProvider } from './providers/shopaikey.provider';

@Module({
  imports: [ConfigModule, GeminiModule],
  providers: [
    VyceAIProvider,
    ShopAIKeyProvider,
    {
      provide: AI_PROVIDERS,
      useFactory: (
        gemini: GeminiService,
        vyceai: VyceAIProvider,
        shopaikey: ShopAIKeyProvider,
      ) => [gemini, vyceai, shopaikey],
      inject: [GeminiService, VyceAIProvider, ShopAIKeyProvider],
    },
    AIService,
  ],
  exports: [AIService],
})
export class AIModule {}
