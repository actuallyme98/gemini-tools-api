import { Injectable } from '@nestjs/common';
import { AIService } from '../ai/ai.service';
import { R2Service } from '../r2/r2.service';
import { withRetry } from '../utils/function.util';

@Injectable()
export class BackgroundService {
  constructor(
    private readonly ai: AIService,
    private readonly r2: R2Service,
  ) {}

  async replace(params: {
    productImage: Express.Multer.File;
    backgroundImage: Express.Multer.File;
    instructions: string;
    variationIndex: number;
    provider?: string;
    imageModel?: string;
    signal?: AbortSignal;
  }) {
    this.ai.validateSelection(params.provider, ['image']);
    if (params.imageModel !== undefined)
      await this.ai.validateImageModel(params.provider, params.imageModel);
    const image = await withRetry(
      () =>
        this.ai.replaceBackground(
          {
            productImage: {
              base64: params.productImage.buffer.toString('base64'),
              mimeType: params.productImage.mimetype,
            },
            backgroundImage: {
              base64: params.backgroundImage.buffer.toString('base64'),
              mimeType: params.backgroundImage.mimetype,
            },
            instructions: params.instructions,
            variationIndex: params.variationIndex,
            ...(params.imageModel !== undefined
              ? { imageModel: params.imageModel }
              : {}),
          },
          params.provider,
        ),
      { signal: params.signal, retries: 1 },
    );
    params.signal?.throwIfAborted();
    // Retry upload independently so a storage failure never repeats paid image generation.
    const url = await withRetry(
      () => this.r2.upload(image.buffer, image.mimeType),
      { signal: params.signal },
    );
    return { url, mimeType: image.mimeType };
  }
}
