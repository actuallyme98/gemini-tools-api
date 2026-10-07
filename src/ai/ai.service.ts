import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_PROVIDERS } from './ai-provider';
import type {
  AICapability,
  AIProvider,
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
  ): Promise<ImageAnalysis> {
    const result = await this.providerFor('vision').generateJSON(
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
  ): Promise<string[]> {
    const result = await this.providerFor('text').generateJSON(
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
  ): Promise<Idea[]> {
    const result = await this.providerFor('text').generateJSON(
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

  generateImage(prompt: string): Promise<Buffer> {
    const provider = this.providerFor('image');
    if (!provider.generateImage)
      throw new Error('AI provider cannot generate images');
    return provider.generateImage(prompt);
  }

  editImage(params: EditImageParams): Promise<Buffer> {
    const provider = this.providerFor('image');
    if (!provider.editImage) throw new Error('AI provider cannot edit images');
    return provider.editImage(params);
  }

  generateImagesFromReferalImages(
    params: ReferenceImagesParams,
  ): Promise<Buffer[]> {
    const provider = this.providerFor('image');
    if (!provider.generateImagesFromReferalImages) {
      throw new Error('AI provider cannot generate images from references');
    }
    return provider.generateImagesFromReferalImages(params);
  }

  private providerFor(capability: AICapability): AIProvider {
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
