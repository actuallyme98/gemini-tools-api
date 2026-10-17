import { Injectable, Optional } from '@nestjs/common';
import { AuditLogService } from '../audit/audit-log.service';
import { ConfigService } from '@nestjs/config';
import type { GoogleGenAIOptions } from '@google/genai' with { 'resolution-mode': 'import' };
import { GoogleGenAIProvider } from '../ai/providers/google-genai.provider';

@Injectable()
export class GeminiService extends GoogleGenAIProvider {
  readonly name = 'Gemini';
  constructor(config: ConfigService, @Optional() audit?: AuditLogService) {
    super(
      config,
      {
        id: 'gemini',
        apiKeyConfig: 'GEMINI_API_KEY',
        models: {
          text: { key: 'GEMINI_MODEL_TEXT', default: 'gemini-2.5-flash-lite' },
          vision: {
            key: 'GEMINI_MODEL_MULTIMODAL',
            default: 'gemini-2.5-flash',
          },
          image: {
            key: 'GEMINI_MODEL_IMAGE',
            default: 'gemini-2.5-flash-image',
          },
        },
      },
      audit,
    );
  }

  protected clientOptions(apiKey: string): GoogleGenAIOptions {
    return { apiKey };
  }
}
