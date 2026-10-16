import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeminiModule } from '../gemini/gemini.module';
import { GeminiService } from '../gemini/gemini.service';
import { AI_PROVIDERS } from './ai-provider';
import { AIService } from './ai.service';
import { AIController } from './ai.controller';
import { ShopAIKeyProvider } from './providers/shopaikey.provider';
import { VyceAIProvider } from './providers/vyceai.provider';
import { TextRouterService } from './text-router.service';

@Module({
  imports: [ConfigModule, GeminiModule],
  controllers: [AIController],
  providers: [
    ShopAIKeyProvider,
    VyceAIProvider,
    TextRouterService,
    {
      provide: AI_PROVIDERS,
      useFactory: (gemini: GeminiService, shopaikey: ShopAIKeyProvider) => [
        gemini,
        shopaikey,
      ],
      inject: [GeminiService, ShopAIKeyProvider],
    },
    AIService,
  ],
  exports: [AIService],
})
export class AIModule {}
