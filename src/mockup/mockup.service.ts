import { Injectable } from '@nestjs/common';
import { ChatGPTService } from '../chatgpt/chatgpt.service';
import { GeminiService } from '../gemini/gemini.service';
import { R2Service } from '../r2/r2.service';

import { withRetry } from 'src/utils/function.util';

@Injectable()
export class MockupService {
  constructor(
    private readonly chatGPTService: ChatGPTService,
    private readonly geminiService: GeminiService,
    private readonly r2Service: R2Service,
  ) {}

  async generateMockups(file: Express.Multer.File, prompts: string[]) {
    const base64Image = file.buffer.toString('base64');

    const handlePrompt = async (prompt: string, index: number) => {
      const editedBuffer = await withRetry(() =>
        this.geminiService.editImage({
          base64Image,
          mimeType: file.mimetype,
          prompt,
        }),
      );

      const url = await withRetry(() => this.r2Service.upload(editedBuffer));

      return { index, prompt, url };
    };

    const results = [];

    for (let i = 0; i < prompts.length; i++) {
      results.push(await handlePrompt(prompts[i], i));
    }

    return { total: results.length, results };
  }

  async generateMockupPrompts(image: Express.Multer.File, mockupCount: number) {
    return withRetry(async () => {
      const garmentProfile =
        await this.geminiService.analyzeProductFromImage(image);

      return this.geminiService.generateMockupPrompts(
        garmentProfile,
        mockupCount,
      );
    });
  }
}
