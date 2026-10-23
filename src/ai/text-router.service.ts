import { Injectable, Logger } from '@nestjs/common';
import type { AICapability, AIProvider } from './ai-provider';
import { VyceAIProvider } from './providers/vyceai.provider';
import { ShopAIKeyProvider } from './providers/shopaikey.provider';
import { externalServiceError } from '../common/external-service-error';
import { isBudgetError } from '../agent/budget.util';

@Injectable()
export class TextRouterService implements AIProvider {
  readonly id = 'auto-text';
  readonly name = 'VyceAI → ShopAIKey';
  readonly capabilities = ['text'] as const;
  private readonly logger = new Logger(TextRouterService.name);
  constructor(
    private readonly vyceai: VyceAIProvider,
    private readonly shopaikey: ShopAIKeyProvider,
  ) {}

  validateConfiguration(capability: AICapability): void {
    try {
      this.vyceai.validateConfiguration(capability);
    } catch {
      this.shopaikey.validateConfiguration(capability);
    }
  }

  async generateJSON(prompt: string): Promise<unknown> {
    try {
      return await this.vyceai.generateJSON(prompt);
    } catch (error) {
      if (isBudgetError(error)) throw error;
      this.logger.warn(
        'Preferred VyceAI text models unavailable; using ShopAIKey.',
      );
    }
    try {
      return await this.shopaikey.generateJSON(prompt);
    } catch (error) {
      throw externalServiceError('ai', error, this.shopaikey);
    }
  }
}
