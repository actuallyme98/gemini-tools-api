import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GoogleGenAIOptions } from '@google/genai' with { 'resolution-mode': 'import' };
import { GoogleGenAIProvider } from './google-genai.provider';
import type { AIImageModelCatalog } from '../ai-provider';

@Injectable()
export class ShopAIKeyProvider extends GoogleGenAIProvider {
  readonly name = 'ShopAIKey';
  private modelCache?: { expires: number; catalog: AIImageModelCatalog };
  private modelRequest?: Promise<AIImageModelCatalog>;

  async getImageModels(refresh = false): Promise<AIImageModelCatalog> {
    this.validateConfiguration('text');
    if (!refresh && this.modelCache && this.modelCache.expires > Date.now())
      return this.modelCache.catalog;
    if (this.modelRequest !== undefined) return this.modelRequest;
    const request = this.fetchImageModels();
    this.modelRequest = request;
    try {
      const catalog = await request;
      this.modelCache = { expires: Date.now() + 5 * 60 * 1000, catalog };
      return catalog;
    } finally {
      this.modelRequest = undefined;
    }
  }

  private async fetchImageModels(): Promise<AIImageModelCatalog> {
    const apiKey = this.config.getOrThrow<string>('SHOPAIKEY_API_KEY');
    const baseUrl = this.config
      .get<string>('SHOPAIKEY_BASE_URL', 'https://api.shopaikey.com')
      .replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/v1beta/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(
        this.config.get<number>('SHOPAIKEY_TIMEOUT_MS', 60000),
      ),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw Object.assign(
        new Error('AI provider returned an invalid model catalog'),
        { status: response.status >= 400 ? response.status : undefined },
      );
    }
    const root = asRecord(body);
    if (!response.ok) {
      const upstream = asRecord(root?.error);
      throw Object.assign(
        new Error(
          typeof upstream?.message === 'string'
            ? upstream.message
            : 'Model catalog request failed',
        ),
        { status: response.status },
      );
    }
    const entries = root?.models ?? root?.data;
    if (!Array.isArray(entries))
      throw new Error('AI provider returned an invalid model catalog');
    const models = new Map<string, { id: string; name: string }>();
    for (const entry of entries) {
      const model = asRecord(entry);
      const rawId = model?.id ?? model?.name;
      if (typeof rawId !== 'string') continue;
      const id = rawId.replace(/^models\//, '');
      // This adapter uses native Gemini generateContent. GPT/Grok and Nano Banana
      // endpoint aliases cannot be routed through that API just because they appear in the catalog.
      if (id.length > 128 || !/^gemini-[a-z0-9._-]*image[a-z0-9._-]*$/.test(id))
        continue;
      models.set(id, {
        id,
        name: typeof model.displayName === 'string' ? model.displayName : id,
      });
    }
    const configured = this.config.get<string>('SHOPAIKEY_MODEL_IMAGE');
    return {
      provider: this.id,
      defaultModel: configured && models.has(configured) ? configured : null,
      models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
