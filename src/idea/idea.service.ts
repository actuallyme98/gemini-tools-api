import { Injectable } from '@nestjs/common';
import { AIService } from '../ai/ai.service';
import { R2Service } from '../r2/r2.service';

import { withRetry } from '../utils/function.util';

import { GenerateIdeaReturn } from './types';

@Injectable()
export class IdeaService {
  constructor(
    private readonly aiService: AIService,
    private readonly r2Service: R2Service,
  ) {}

  async analyzeProductFromImage(file: Express.Multer.File, provider?: string) {
    return this.aiService.analyzeProductFromImage(file, provider);
  }

  async generateIdeasFromImage(
    file: Express.Multer.File,
    basePrompt: string,
    count = 3,
    signal?: AbortSignal,
    provider?: string,
  ) {
    this.aiService.validateSelection(provider, ['text', 'image']);
    const base64Image = file.buffer.toString('base64');

    const ideas = await withRetry(
      () =>
        this.aiService.generateIdeasFromAttributes(basePrompt, count, provider),
      { signal },
    );

    const results: GenerateIdeaReturn[] = [];

    for (const { prompt } of ideas) {
      signal?.throwIfAborted();
      const editedBuffer = await withRetry(
        () =>
          this.aiService.editImage(
            {
              base64Image,
              mimeType: file.mimetype,
              prompt,
            },
            provider,
          ),
        { signal },
      );

      const url = await withRetry(() => this.r2Service.upload(editedBuffer), {
        signal,
      });

      results.push({ url, prompt });
    }

    return results;
  }

  async generateIdeasFromReferalImages(params: {
    productImage: Express.Multer.File;
    referenceImages?: Express.Multer.File[];
    variations?: number;
    signal?: AbortSignal;
    provider?: string;
  }) {
    const { productImage, referenceImages, variations, signal, provider } =
      params;
    this.aiService.validateSelection(provider, ['image']);
    const productImageBase64 = productImage.buffer.toString('base64');

    const results: string[] = [];
    // Retry each variation independently so successful paid generations are retained.
    for (let i = 0; i < (variations ?? 1); i++) {
      signal?.throwIfAborted();
      const buffers = await withRetry(
        () =>
          this.aiService.generateImagesFromReferalImages(
            {
              productImageBase64,
              productMimeType: productImage.mimetype,
              referenceImages: referenceImages?.map((file) => ({
                base64: file.buffer.toString('base64'),
                mimeType: file.mimetype,
              })),
              variations: 1,
              variationIndex: i + 1,
            },
            provider,
          ),
        { signal },
      );
      if (!buffers[0])
        throw new Error('AI provider returned no reference image');
      const url = await withRetry(() => this.r2Service.upload(buffers[0]), {
        signal,
      });
      results.push(url);
    }
    return results;
  }
}
