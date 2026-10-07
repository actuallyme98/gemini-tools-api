import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GoogleGenAIOptions } from '@google/genai' with { 'resolution-mode': 'import' };
import { GoogleGenAIProvider } from '../ai/providers/google-genai.provider';

@Injectable()
export class GeminiService extends GoogleGenAIProvider {
  constructor(config: ConfigService) {
    super(config, {
      id: 'gemini',
      apiKeyConfig: 'GEMINI_API_KEY',
      models: {
        text: { key: 'GEMINI_MODEL_TEXT', default: 'gemini-2.5-flash-lite' },
        vision: { key: 'GEMINI_MODEL_MULTIMODAL', default: 'gemini-2.5-flash' },
        image: { key: 'GEMINI_MODEL_IMAGE', default: 'gemini-2.5-flash-image' },
      },
    });
  }

  protected clientOptions(apiKey: string): GoogleGenAIOptions {
    return { apiKey };
  }
}
