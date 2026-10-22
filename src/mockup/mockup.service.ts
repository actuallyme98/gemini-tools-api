import { Injectable } from '@nestjs/common';
import { AIService } from '../ai/ai.service';
import { R2Service } from '../r2/r2.service';

import { withRetry } from '../utils/function.util';
import { imageMimeType } from '../utils/image.util';

@Injectable()
export class MockupService {
  constructor(
    private readonly aiService: AIService,
    private readonly r2Service: R2Service,
  ) {}

  async generateMockup(
    file: Express.Multer.File,
    prompt: string,
    signal?: AbortSignal,
    provider?: string,
    imageModel?: string,
  ) {
    this.aiService.validateSelection(provider, ['image']);
    if (imageModel !== undefined)
      await this.aiService.validateImageModel(provider, imageModel);
    const buffer = await withRetry(
      () =>
        this.aiService.editImage(
          {
            base64Image: file.buffer.toString('base64'),
            mimeType: file.mimetype,
            prompt,
            ...(imageModel ? { imageModel } : {}),
          },
          provider,
        ),
      { signal, retries: 1 },
    );
    signal?.throwIfAborted();
    const mimeType = imageMimeType(buffer) || 'image/png';
    const url = await withRetry(() => this.r2Service.upload(buffer, mimeType), {
      signal,
    });
    return { url, mimeType };
  }

  async generateMockups(
    file: Express.Multer.File,
    prompts: string[],
    signal?: AbortSignal,
    provider?: string,
    imageModel?: string,
  ) {
    this.aiService.validateSelection(provider, ['image']);
    if (imageModel !== undefined)
      await this.aiService.validateImageModel(provider, imageModel);
    const handlePrompt = async (prompt: string, index: number) => {
      const { url } = await this.generateMockup(
        file,
        prompt,
        signal,
        provider,
        imageModel,
      );

      return { index, prompt, url };
    };

    const results = [];

    for (let i = 0; i < prompts.length; i++) {
      signal?.throwIfAborted();
      results.push(await handlePrompt(prompts[i], i));
    }

    return { total: results.length, results };
  }

  async generateMockupPrompts(
    image: Express.Multer.File,
    mockupCount: number,
    signal?: AbortSignal,
    provider?: string,
  ) {
    this.aiService.validateSelection(provider, ['vision', 'text']);
    return withRetry(
      async () => {
        const garmentProfile = await this.aiService.analyzeProductFromImage(
          image,
          provider,
        );

        signal?.throwIfAborted();
        return this.aiService.generateMockupPrompts(
          garmentProfile,
          mockupCount,
          provider,
        );
      },
      { signal },
    );
  }
}
