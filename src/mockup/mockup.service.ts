import { Injectable } from '@nestjs/common';
import { AIService } from '../ai/ai.service';
import { R2Service } from '../r2/r2.service';

import { withRetry } from '../utils/function.util';

@Injectable()
export class MockupService {
  constructor(
    private readonly aiService: AIService,
    private readonly r2Service: R2Service,
  ) {}

  async generateMockups(
    file: Express.Multer.File,
    prompts: string[],
    signal?: AbortSignal,
    provider?: string,
  ) {
    const base64Image = file.buffer.toString('base64');

    const handlePrompt = async (prompt: string, index: number) => {
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
