import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_PROVIDERS } from './ai-provider';
import type {
  AICapability,
  AIProvider,
  AIProviderCatalog,
  EditImageParams,
  ReferenceImagesParams,
} from './ai-provider';
import type { Idea, ImageAnalysis } from './types';
import {
  ANALYZE_PRODUCT_FROM_IMAGE_PROMPT,
  toGenerateMockupPrompts,
} from '../constants/mockup-system-prompt';

@Injectable()
export class AIService implements OnModuleInit {
  private readonly providers = new Map<string, AIProvider>();

  constructor(
    private readonly config: ConfigService,
    @Inject(AI_PROVIDERS) providers: AIProvider[],
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new Error(`Duplicate AI provider: ${provider.id}`);
      }
      this.providers.set(provider.id, provider);
    }
  }

  onModuleInit(): void {
    for (const capability of ['text', 'vision', 'image'] as const) {
      this.providerFor(capability).validateConfiguration(capability);
    }
    const imageProvider = this.providerFor('image');
    if (
      !imageProvider.generateImage ||
      !imageProvider.editImage ||
      !imageProvider.generateImagesFromReferalImages
    ) {
      throw new Error(
        `AI provider "${imageProvider.id}" is missing image operations`,
      );
    }
  }

  async analyzeProductFromImage(
    file: Express.Multer.File,
    providerId?: string,
  ): Promise<ImageAnalysis> {
    const result = await this.providerFor('vision', providerId).generateJSON(
      ANALYZE_PRODUCT_FROM_IMAGE_PROMPT,
      { base64: file.buffer.toString('base64'), mimeType: file.mimetype },
    );
    if (!isImageAnalysis(result)) {
      throw new Error('AI provider returned an invalid product analysis');
    }
    return result;
  }

  async generateMockupPrompts(
    analysis: ImageAnalysis,
    count: number,
    providerId?: string,
  ): Promise<string[]> {
    const result = await this.providerFor('text', providerId).generateJSON(
      toGenerateMockupPrompts(analysis, count),
    );
    if (
      !Array.isArray(result) ||
      result.length !== count ||
      !result.every(
        (prompt: unknown) => typeof prompt === 'string' && prompt.trim(),
      )
    ) {
      throw new Error(
        `AI provider must return exactly ${count} non-empty mockup prompts`,
      );
    }
    return result as string[];
  }

  async generateIdeasFromAttributes(
    basePrompt: string,
    count?: number,
    providerId?: string,
  ): Promise<Idea[]> {
    const result = await this.providerFor('text', providerId).generateJSON(
      `${basePrompt}${count ? `\nGenerate exactly ${count} ideas.` : ''}\n\nReturn only a non-empty JSON array of objects with string fields title, description, and prompt. Each prompt must be a complete instruction for editing the product image.`,
    );
    if (
      !Array.isArray(result) ||
      !result.length ||
      !result.every(isIdea) ||
      (count !== undefined && result.length !== count)
    ) {
      throw new Error('AI provider returned an invalid list of ideas');
    }
    return result;
  }

  generateImage(prompt: string, providerId?: string): Promise<Buffer> {
    const provider = this.providerFor('image', providerId);
    if (!provider.generateImage)
      throw new Error('AI provider cannot generate images');
    return provider.generateImage(prompt);
  }

  editImage(params: EditImageParams, providerId?: string): Promise<Buffer> {
    const provider = this.providerFor('image', providerId);
    if (!provider.editImage) throw new Error('AI provider cannot edit images');
    return provider.editImage(params);
  }

  generateImagesFromReferalImages(
    params: ReferenceImagesParams,
    providerId?: string,
  ): Promise<Buffer[]> {
    const provider = this.providerFor('image', providerId);
    if (!provider.generateImagesFromReferalImages) {
      throw new Error('AI provider cannot generate images from references');
    }
    return provider.generateImagesFromReferalImages(params);
  }

  getProviders(): AIProviderCatalog {
    const defaults = {
      text: this.providerFor('text').id,
      vision: this.providerFor('vision').id,
      image: this.providerFor('image').id,
    };
    return {
      defaults,
      providers: [...this.providers.values()].map((provider) => {
        const capabilities = this.configuredCapabilities(provider);
        return {
          id: provider.id,
          name: provider.name || provider.id,
          available: capabilities.length > 0,
          capabilities,
          routing: {
            text: capabilities.includes('text') ? provider.id : defaults.text,
            vision: capabilities.includes('vision')
              ? provider.id
              : defaults.vision,
            image: capabilities.includes('image')
              ? provider.id
              : defaults.image,
          },
        };
      }),
    };
  }

  private configuredCapabilities(provider: AIProvider): AICapability[] {
    return provider.capabilities.filter((capability) => {
      if (
        capability === 'image' &&
        (!provider.generateImage ||
          !provider.editImage ||
          !provider.generateImagesFromReferalImages)
      )
        return false;
      try {
        provider.validateConfiguration(capability);
        return true;
      } catch {
        // Configuration errors may contain private configuration; expose availability only.
        return false;
      }
    });
  }

  private providerFor(
    capability: AICapability,
    providerId?: string,
  ): AIProvider {
    if (providerId !== undefined) {
      const selected = this.providers.get(providerId);
      if (!selected) throw new BadRequestException('Provider AI không hợp lệ.');
      const capabilities = this.configuredCapabilities(selected);
      if (!capabilities.length)
        throw new BadRequestException(
          'Provider AI chưa được cấu hình trên máy chủ.',
        );
      if (capabilities.includes(capability)) return selected;
      // Only unsupported/unconfigured capabilities use the system default.
      // Execution errors from a selected provider are never retried on another provider.
    }
    const key = `AI_${capability.toUpperCase()}_PROVIDER`;
    const id =
      this.config.get<string>(key) ||
      this.config.get<string>('AI_PROVIDER', 'gemini');
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown AI provider "${id}" for ${key}`);
    if (!provider.capabilities.includes(capability)) {
      throw new Error(
        `AI provider "${id}" does not support ${capability}; change ${key}`,
      );
    }
    return provider;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string')
  );
}

function isImageAnalysis(value: unknown): value is ImageAnalysis {
  if (!isRecord(value) || !isRecord(value.material)) return false;
  const inspired = value.inspiredBy;
  if (
    inspired !== undefined &&
    (!isRecord(inspired) ||
      !['source', 'theme', 'setting', 'styleReference'].every(
        (key) => typeof inspired[key] === 'string',
      ))
  )
    return false;
  const characters = value.characters;
  if (
    characters !== undefined &&
    (!isRecord(characters) ||
      typeof characters.hasCharacters !== 'boolean' ||
      !isStringArray(characters.characterNames) ||
      !isStringArray(characters.characterType) ||
      !Number.isInteger(characters.numberOfCharacters) ||
      Number(characters.numberOfCharacters) < 0 ||
      !['relationship', 'visualDescription'].every(
        (key) => typeof characters[key] === 'string',
      ))
  )
    return false;
  return (
    ['productCategory', 'productType', 'pattern', 'mood', 'audience'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    ['worn', 'product_only'].includes(value.displayMode as string) &&
    isStringArray(value.primaryColors) &&
    isStringArray(value.styleKeywords) &&
    [
      'main',
      'details',
      'texture',
      'weightOrThickness',
      'flexibility',
      'breathability',
    ].every(
      (key) =>
        typeof (value.material as Record<string, unknown>)[key] === 'string',
    ) &&
    isStringArray(value.material.seasonSuitability)
  );
}

function isIdea(value: unknown): value is Idea {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.prompt === 'string' &&
    value.prompt.trim().length > 0
  );
}
