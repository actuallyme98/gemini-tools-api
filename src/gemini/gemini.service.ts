import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ANALYZE_PRODUCT_FROM_IMAGE_PROMPT,
  toGenerateMockupPrompts,
} from 'src/constants/mockup-system-prompt';

import { Idea, ImageAnalysis } from './types';

@Injectable()
export class GeminiService {
  private openai: any;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const { GoogleGenAI } = await import('@google/genai');

    const apiKey = this.config.get<string>('GEMINI_API_KEY');

    this.openai = new GoogleGenAI({ apiKey });
  }

  async generateImage(prompt: string): Promise<Buffer> {
    const response = await this.openai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: prompt,
    });
    for (const part of response.candidates[0].content.parts) {
      if (part.text) {
      } else if (part.inlineData) {
        const imageData = part.inlineData.data;
        const buffer = Buffer.from(imageData, 'base64');
        return buffer;
      }
    }
  }

  async generateImagesFromReferalImages(params: {
    productImageBase64: string;
    productMimeType: string;
    referenceImages?: {
      base64: string;
      mimeType: string;
    }[];
    variations?: number;
  }): Promise<Buffer[]> {
    const { variations, productImageBase64, productMimeType, referenceImages } =
      params;

    const normalizeBase64 = (b64: string) =>
      b64.includes(',') ? b64.split(',')[1] : b64;

    const parts: any[] = [];

    parts.push({
      text: `
      You are editing the FIRST image only.

      The first image is the original product image.
      Preserve the product’s design, colors, patterns, proportions, and details exactly.
      Do NOT redraw, reinterpret, stylize, or modify the product in any way.
      
      All other images are for visual reference and inspiration only
      (e.g. lighting, composition, mood).
      Do NOT copy subjects, objects, characters, or exact layouts from reference images.
      
      Replace the background with a clean, solid studio background.
      
      Default background color: pure white.
      
      If the product is white or very light-colored,
      automatically choose a different neutral background color
      (light gray, beige, or soft pastel)
      to ensure strong contrast and clear visibility of the product.
      
      The background must be:
      - smooth
      - uniform
      - flat color only
      - no texture, no gradient, no pattern
      
      Add soft, realistic studio lighting and a subtle natural shadow
      to ground the product.
      
      ABSOLUTELY NO text, logos, watermarks, symbols, or repeating patterns.
      
      The final image must look like a professional e-commerce product photo,
      clean, minimal, and ready for product listing.      
    `,
    });

    parts.push({
      text: 'Đây là ảnh mẫu sản phẩm gốc: ',
    });
    parts.push({
      inlineData: {
        mimeType: productMimeType,
        data: normalizeBase64(productImageBase64),
      },
    });

    if (referenceImages?.length) {
      parts.push({
        text: `
          Chuyển những hình ảnh sau in lên mẫu áo
          Sắp xếp các chi tiết hình ảnh sao cho hài hòa, đẹp mắt
          Có thể thêm 1 vài họa tiết nhỏ phù hợp với chủ đề hình ảnh chính tăng tính thẩm mỹ
          Nếu ảnh sau vi phạm bản quyền hãy thêm 1 vài chi tiết nhỏ trên nhân vật để tránh vi phạm
        `,
      });

      for (const ref of referenceImages) {
        parts.push({
          inlineData: {
            mimeType: ref.mimeType,
            data: normalizeBase64(ref.base64),
          },
        });
      }
    }

    const response = await this.openai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
    });

    const resultParts = response.candidates?.[0]?.content?.parts;
    if (!resultParts) {
      console.error(JSON.stringify(response, null, 2));
      throw new Error('No content returned from Gemini');
    }

    const images: Buffer[] = [];

    for (const part of resultParts) {
      if (part.inlineData?.data) {
        images.push(Buffer.from(part.inlineData.data, 'base64'));
      }
    }

    if (!images.length) {
      throw new Error('No images returned from Gemini');
    }

    return images;
  }

  async editImage(params: {
    base64Image: string;
    mimeType: string;
    prompt: string;
  }): Promise<Buffer> {
    const base64Data = params.base64Image.includes(',')
      ? params.base64Image.split(',')[1]
      : params.base64Image;

    const response = await this.openai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [
        {
          role: 'user',
          parts: [
            { text: params.prompt },
            {
              inlineData: {
                mimeType: params.mimeType,
                data: base64Data,
              },
            },
          ],
        },
      ],
    });

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts) {
      console.error(JSON.stringify(response, null, 2));
      throw new Error('No content returned from Gemini');
    }

    for (const part of parts) {
      if (part.inlineData?.data) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }

    throw new Error('No image returned from Gemini');
  }

  async analyzeProductFromImage(file: Express.Multer.File) {
    const base64 = file.buffer.toString('base64');

    const result = await this.openai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: ANALYZE_PRODUCT_FROM_IMAGE_PROMPT,
            },
            {
              inlineData: {
                mimeType: file.mimetype,
                data: base64,
              },
            },
          ],
        },
      ],
    });

    return this.parseGeminiJSON(result);
  }

  async generateMockupPrompts(
    analysis: ImageAnalysis,
    mockupCount: number,
  ): Promise<string[]> {
    const prompt = toGenerateMockupPrompts(analysis, mockupCount);

    const response = await this.openai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    });

    return this.parseGeminiJSON(response);
  }

  async generateIdeasFromAttributes(basePrompt: string): Promise<Idea[]> {
    const response = await this.openai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{ text: basePrompt }],
        },
      ],
    });

    return this.parseGeminiJSON(response);
  }

  private parseGeminiJSON(result: any) {
    const text =
      result.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? '')
        .join('')
        .trim() ?? '';

    if (!text) {
      throw new Error('Empty response from Gemini');
    }

    const cleaned = text
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    return JSON.parse(cleaned);
  }
}
