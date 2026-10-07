import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import type { AICapability, AIInputImage, AIProvider } from '../ai-provider';
import { parseAIJSON } from '../json.util';

@Injectable()
export class VyceAIProvider implements AIProvider {
  readonly id = 'vyceai';
  private client?: OpenAI;

  constructor(private readonly config: ConfigService) {}

  get capabilities(): readonly AICapability[] {
    return this.config.get<boolean>('VYCEAI_VISION_ENABLED', false)
      ? ['text', 'vision']
      : ['text'];
  }

  validateConfiguration(capability: AICapability): void {
    if (!this.capabilities.includes(capability)) {
      throw new Error(
        `VyceAI does not support configured capability: ${capability}`,
      );
    }
    if (!this.config.get<string>('VYCEAI_API_KEY')) {
      throw new Error('VYCEAI_API_KEY is required when using VyceAI');
    }
    const modelKey = this.modelKey(capability);
    if (!this.config.get<string>(modelKey)) {
      throw new Error(
        `${modelKey} is required when using VyceAI for ${capability}`,
      );
    }
  }

  async generateJSON(prompt: string, image?: AIInputImage): Promise<unknown> {
    const capability = image ? 'vision' : 'text';
    this.validateConfiguration(capability);

    this.client ??= new OpenAI({
      apiKey: this.config.getOrThrow<string>('VYCEAI_API_KEY'),
      baseURL: this.config.get<string>(
        'VYCEAI_BASE_URL',
        'https://vyceai.com/v1',
      ),
      timeout: this.config.get<number>('VYCEAI_TIMEOUT_MS', 60000),
      // Business services already use withRetry; avoid multiplying attempts.
      maxRetries: 0,
    });

    const content: ChatCompletionContentPart[] = [
      { type: 'text', text: prompt },
    ];
    if (image) {
      const base64 = image.base64.includes(',')
        ? image.base64.slice(image.base64.indexOf(',') + 1)
        : image.base64;
      content.push({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${base64}` },
      });
    }

    const response = await this.client.chat.completions.create({
      model: this.config.getOrThrow<string>(this.modelKey(capability)),
      messages: [
        {
          role: 'system',
          content:
            'Return only valid JSON matching the requested format. No markdown or explanations.',
        },
        { role: 'user', content: image ? content : prompt },
      ],
    });

    return parseAIJSON(response.choices[0]?.message.content);
  }

  private modelKey(capability: AICapability): string {
    return capability === 'vision'
      ? 'VYCEAI_MODEL_VISION'
      : 'VYCEAI_MODEL_TEXT';
  }
}
