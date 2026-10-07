import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GoogleGenAIOptions } from '@google/genai' with { 'resolution-mode': 'import' };
import { GoogleGenAIProvider } from './google-genai.provider';

@Injectable()
export class ShopAIKeyProvider extends GoogleGenAIProvider {
  readonly name = 'ShopAIKey';
  constructor(config: ConfigService) {
    super(config, {
      id: 'shopaikey',
      apiKeyConfig: 'SHOPAIKEY_API_KEY',
      models: {
        text: { key: 'SHOPAIKEY_MODEL_TEXT', default: 'gemini-2.5-flash' },
        vision: { key: 'SHOPAIKEY_MODEL_VISION', default: 'gemini-2.5-flash' },
        // Require an explicit native image model ID available to the account.
        image: { key: 'SHOPAIKEY_MODEL_IMAGE' },
      },
      imageResponseModalities: true,
    });
  }

  protected override clientOptions(
    apiKey: string,
    forImages: boolean,
  ): GoogleGenAIOptions {
    return {
      apiKey,
      httpOptions: {
        baseUrl: forImages
          ? this.config.get<string>(
              'SHOPAIKEY_IMAGE_BASE_URL',
              'https://direct.shopaikey.com',
            )
          : this.config.get<string>(
              'SHOPAIKEY_BASE_URL',
              'https://api.shopaikey.com',
            ),
        apiVersion: 'v1beta',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: forImages
          ? this.config.get<number>('SHOPAIKEY_IMAGE_TIMEOUT_MS', 180000)
          : this.config.get<number>('SHOPAIKEY_TIMEOUT_MS', 60000),
      },
    };
  }
}
