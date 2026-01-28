import { Injectable } from '@nestjs/common';
import { ChatGPTService } from '../chatgpt/chatgpt.service';
import { GeminiService } from '../gemini/gemini.service';
import { R2Service } from '../r2/r2.service';

import { withRetry } from 'src/utils/function.util';

import { GenerateIdeaReturn } from './types';

@Injectable()
export class IdeaService {
  constructor(
    private readonly chatGPTService: ChatGPTService,
    private readonly geminiService: GeminiService,
    private readonly r2Service: R2Service,
  ) {}

  async analyzeProductFromImage(file: Express.Multer.File) {
    return this.geminiService.analyzeProductFromImage(file);
  }

  async generateIdeasFromImage(file: Express.Multer.File, basePrompt: string) {
    const base64Image = file.buffer.toString('base64');

    const ideas = await withRetry(() =>
      this.geminiService.generateIdeasFromAttributes(basePrompt),
    );

    const results: GenerateIdeaReturn[] = [];

    for (const { prompt } of ideas) {
      const editedBuffer = await withRetry(() =>
        this.geminiService.editImage({
          base64Image,
          mimeType: file.mimetype,
          prompt,
        }),
      );

      const url = await withRetry(() => this.r2Service.upload(editedBuffer));

      results.push({ url, prompt });
    }

    return results;
  }

  async generateIdeasFromReferalImages(params: {
    productImage: Express.Multer.File;
    referenceImages?: Express.Multer.File[];
    variations?: number;
  }) {
    const { productImage, referenceImages, variations } = params;
    const productImageBase64 = productImage.buffer.toString('base64');

    const buffers = await withRetry(
      () =>
        this.geminiService.generateImagesFromReferalImages({
          productImageBase64,
          productMimeType: productImage.mimetype,
          referenceImages: referenceImages?.map((file) => ({
            base64: file.buffer.toString('base64'),
            mimeType: file.mimetype,
          })),
          variations,
        }),
      {
        retries: 5,
      },
    );

    const results: string[] = [];

    for (const buffer of buffers) {
      const url = await withRetry(() => this.r2Service.upload(buffer));
      results.push(url);
    }

    return results;
  }
}
