import { Injectable, Optional } from '@nestjs/common';
import { AuditLogService } from '../../audit/audit-log.service';
import { ConfigService } from '@nestjs/config';
import type {
  GoogleGenAIOptions,
  GenerateContentResponse,
} from '@google/genai' with { 'resolution-mode': 'import' };
import { GoogleGenAIProvider } from './google-genai.provider';
import { BudgetService } from '../../agent/budget.service';
import type { AIImageModelCatalog } from '../ai-provider';
import {
  imageModelFamily,
  ShopAIKeyImagesClient,
} from './shopaikey-images.client';

@Injectable()
export class ShopAIKeyProvider extends GoogleGenAIProvider {
  readonly name = 'ShopAIKey';
  private modelCache?: { expires: number; catalog: AIImageModelCatalog };
  private modelRequest?: Promise<AIImageModelCatalog>;
  private readonly imageAPI: ShopAIKeyImagesClient;

  protected override async normalizeImageResponse(
    response: GenerateContentResponse,
  ): Promise<GenerateContentResponse> {
    const parts =
      response.candidates
        ?.flatMap((candidate) => candidate.content?.parts || [])
        .filter((part) => !part.thought) || [];
    if (parts.some((part) => part.inlineData?.data)) return response;
    // This gateway can return a Markdown image URL even through the native GenAI endpoint.
    const text = parts.map((part) => part.text || '').join('\n');
    const url = /!\[[^\]]*\]\(\s*(https:\/\/[^\s)]+)\s*\)/.exec(text)?.[1];
    if (!url) return response;
    const image = await this.imageAPI.download(url);
    response.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            {
              inlineData: {
                mimeType: image.mimeType,
                data: image.buffer.toString('base64'),
              },
            },
          ],
        },
      },
    ];
    return response;
  }

  protected override async generateImageContent(
    contents: Parameters<GoogleGenAIProvider['generateImageContent']>[0],
    imageModel?: string,
  ): Promise<GenerateContentResponse> {
    const model =
      imageModel ?? this.config.get<string>('SHOPAIKEY_MODEL_IMAGE');
    const family = model && imageModelFamily(model);
    if (family !== 'gpt' && family !== 'grok')
      return super.generateImageContent(contents, imageModel);
    this.validateConfiguration('image');
    const parts =
      typeof contents === 'string'
        ? [{ text: contents }]
        : contents.flatMap((content) => content.parts);
    const result = await this.imageAPI.generate(
      model,
      parts
        .map((part) => part.text || '')
        .filter(Boolean)
        .join('\n\n'),
      parts.flatMap((part) =>
        part.inlineData?.data
          ? [
              {
                base64: part.inlineData.data,
                mimeType: part.inlineData.mimeType || 'image/png',
              },
            ]
          : [],
      ),
    );
    return {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: result.buffer.toString('base64'),
                  mimeType: result.mimeType,
                },
              },
            ],
          },
        },
      ],
    } as GenerateContentResponse;
  }

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
      // Only model families with an implemented image-editing transport are exposed.
      if (!imageModelFamily(id)) continue;
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
  constructor(
    config: ConfigService,
    @Optional() audit?: AuditLogService,
    @Optional() budget?: BudgetService,
  ) {
    super(
      config,
      {
        id: 'shopaikey',
        apiKeyConfig: 'SHOPAIKEY_API_KEY',
        models: {
          text: { key: 'SHOPAIKEY_MODEL_TEXT', default: 'gemini-2.5-flash' },
          vision: {
            key: 'SHOPAIKEY_MODEL_VISION',
            default: 'gemini-2.5-flash',
          },
          // Require an explicit image model ID available to the account.
          image: { key: 'SHOPAIKEY_MODEL_IMAGE' },
        },
        imageResponseModalities: true,
      },
      audit,
      budget,
    );
    this.imageAPI = new ShopAIKeyImagesClient(config, audit, budget);
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
