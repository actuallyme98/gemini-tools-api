import { Injectable, Logger, Optional } from '@nestjs/common';
import { BudgetService } from '../../agent/budget.service';
import { isBudgetError, responseUsage } from '../../agent/budget.util';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { AIProvider, AICapability } from '../ai-provider';
import { parseAIJSON } from '../json.util';

/** Internal text provider. It is deliberately excluded from the image-provider registry. */
@Injectable()
export class VyceAIProvider implements AIProvider {
  readonly id = 'vyceai';
  readonly name = 'VyceAI';
  readonly capabilities = ['text'] as const;
  private readonly logger = new Logger(VyceAIProvider.name);
  private client?: OpenAI;
  private modelCache?: { expires: number; models: string[] };
  private modelRequest?: Promise<string[]>;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly budget?: BudgetService,
  ) {}

  validateConfiguration(capability: AICapability): void {
    if (capability !== 'text')
      throw new Error('VyceAI is only used for internal text routing');
    if (!this.config.get<string>('VYCEAI_API_KEY'))
      throw new Error('VYCEAI_API_KEY is required for VyceAI text');
  }

  private getClient(): OpenAI {
    this.validateConfiguration('text');
    this.client ??= new OpenAI({
      apiKey: this.config.getOrThrow<string>('VYCEAI_API_KEY'),
      baseURL: this.config.get<string>(
        'VYCEAI_BASE_URL',
        'https://vyceai.com/v1',
      ),
      timeout: this.config.get<number>('VYCEAI_TIMEOUT_MS', 60000),
      maxRetries: 0,
    });
    return this.client;
  }

  async getPreferredModels(): Promise<string[]> {
    if (this.modelCache && this.modelCache.expires > Date.now())
      return this.modelCache.models;
    if (this.modelRequest !== undefined) return this.modelRequest;
    const request = this.fetchPreferredModels();
    this.modelRequest = request;
    try {
      const models = await request;
      this.modelCache = { models, expires: Date.now() + 60000 };
      return models;
    } finally {
      this.modelRequest = undefined;
    }
  }

  private async fetchPreferredModels(): Promise<string[]> {
    const page = await this.getClient().models.list({
      timeout: this.config.get<number>('VYCEAI_HEALTH_TIMEOUT_MS', 10000),
    });
    const ids = [
      ...new Set(
        page.data
          .map((model) => model.id)
          .filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)),
      ),
    ];
    // Bound probes while allowing both preferred families to be checked.
    return [
      ...ids
        .filter(
          (id) =>
            /^gpt[-._]/i.test(id) && !/image|audio|tts|embedding/i.test(id),
        )
        .slice(0, 2),
      ...ids.filter((id) => /^claude[-._]/i.test(id)).slice(0, 2),
    ];
  }

  async isHealthy(model: string): Promise<boolean> {
    try {
      const generate = () =>
        this.getClient().chat.completions.create(
          {
            model,
            messages: [{ role: 'user', content: 'Reply with only OK.' }],
            max_tokens: 32,
          },
          {
            timeout: this.config.get<number>('VYCEAI_HEALTH_TIMEOUT_MS', 10000),
          },
        );
      const response = this.budget
        ? await this.budget.call(
            { provider: this.id, model, operation: 'health' },
            generate,
            (response) => responseUsage(response, 'openai'),
          )
        : await generate();
      const choice = response.choices[0];
      const healthy =
        choice?.finish_reason === 'stop' && !!choice.message.content?.trim();
      if (!healthy) this.logger.warn(`Text health check failed: ${model}`);
      return healthy;
    } catch (error) {
      if (isBudgetError(error)) throw error;
      this.logger.warn(`Text health check failed: ${model}`);
      return false;
    }
  }

  async generateWithModel(prompt: string, model: string): Promise<unknown> {
    const generate = () =>
      this.getClient().chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Return only valid JSON matching the requested format. No markdown or explanations.',
          },
          { role: 'user', content: prompt },
        ],
      });
    const response = this.budget
      ? await this.budget.call(
          { provider: this.id, model, operation: 'text' },
          generate,
          (response) => responseUsage(response, 'openai'),
        )
      : await generate();
    const choice = response.choices[0];
    if (choice?.finish_reason !== 'stop')
      throw new Error('AI provider returned incomplete text output');
    return parseAIJSON(choice.message.content);
  }

  async generateJSON(prompt: string): Promise<unknown> {
    const models = await this.getPreferredModels();
    for (const model of models) {
      // Never reuse a previous request's health result.
      if (await this.isHealthy(model))
        return this.generateWithModel(prompt, model);
    }
    throw new Error('No healthy preferred VyceAI text model is available');
  }
}
