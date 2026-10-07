import { ConfigService } from '@nestjs/config';
import type {
  GoogleGenAI,
  GoogleGenAIOptions,
  GenerateContentResponse,
  Part,
} from '@google/genai' with { 'resolution-mode': 'import' };
import type {
  AIInputImage,
  AIProvider,
  EditImageParams,
  ReferenceImagesParams,
  BackgroundReplacementParams,
  GeneratedImage,
} from '../ai-provider';
import type { AICapability } from '../ai-provider';
import { parseAIJSON } from '../json.util';
import { ApiError } from '../../common/api-error';

interface GoogleGenAIProviderConfig {
  id: string;
  apiKeyConfig: string;
  models: Record<AICapability, { key: string; default?: string }>;
  imageResponseModalities?: boolean;
}

/** Shared native GenAI operations for direct Gemini and compatible gateways. */
export abstract class GoogleGenAIProvider implements AIProvider {
  readonly id: string;
  readonly capabilities = ['text', 'vision', 'image'] as const;
  private genai: GoogleGenAI;
  private imageGenai: GoogleGenAI;
  private modelText: string;
  private modelMultimodal: string;
  private modelImage: string;

  constructor(
    protected readonly config: ConfigService,
    private readonly providerConfig: GoogleGenAIProviderConfig,
  ) {
    this.id = providerConfig.id;
  }

  async onModuleInit() {
    const apiKey = this.config.get<string>(this.providerConfig.apiKeyConfig);
    if (!apiKey) return;
    this.genai = await this.createClient(this.clientOptions(apiKey, false));
    this.imageGenai = await this.createClient(this.clientOptions(apiKey, true));
    this.modelText = this.modelFor('text');
    this.modelMultimodal = this.modelFor('vision');
    this.modelImage = this.modelFor('image');
  }

  validateConfiguration(capability: AICapability): void {
    const apiKeyConfig = this.providerConfig.apiKeyConfig;
    if (!this.config.get<string>(apiKeyConfig)) {
      throw new Error(`${apiKeyConfig} is required when using ${this.id}`);
    }
    if (!this.modelFor(capability)) {
      throw new Error(
        `${this.providerConfig.models[capability].key} is required when using ${this.id} for ${capability}`,
      );
    }
  }

  protected abstract clientOptions(
    apiKey: string,
    forImages: boolean,
  ): GoogleGenAIOptions;

  protected async createClient(
    options: GoogleGenAIOptions,
  ): Promise<GoogleGenAI> {
    const { GoogleGenAI } = await import('@google/genai');
    return new GoogleGenAI(options);
  }

  private modelFor(capability: AICapability): string | undefined {
    const model = this.providerConfig.models[capability];
    return this.config.get<string>(model.key) || model.default;
  }

  private async generateImageContent(
    contents: string | { role: string; parts: Part[] }[],
  ): Promise<GenerateContentResponse> {
    this.validateConfiguration('image');
    const response = await this.imageGenai.models.generateContent({
      model: this.modelImage,
      contents,
      ...(this.providerConfig.imageResponseModalities
        ? { config: { responseModalities: ['TEXT', 'IMAGE'] } }
        : {}),
    });
    this.assertResponse(response);
    return response;
  }

  private assertResponse(response: GenerateContentResponse): void {
    const blocked = response.promptFeedback?.blockReason;
    const finish = String(response.candidates?.[0]?.finishReason || '');
    if (
      blocked ||
      [
        'SAFETY',
        'IMAGE_SAFETY',
        'BLOCKLIST',
        'PROHIBITED_CONTENT',
        'RECITATION',
        'SPII',
      ].includes(finish || '')
    )
      throw new ApiError(
        422,
        'AI_CONTENT_BLOCKED',
        'Provider AI từ chối nội dung hoặc hình ảnh theo chính sách sử dụng.',
        {
          provider: this.id,
          reason: String(blocked || finish),
          suggestion: 'Điều chỉnh prompt hoặc chọn hình ảnh khác.',
        },
      );
    if (finish === 'MAX_TOKENS')
      throw new ApiError(
        502,
        'AI_OUTPUT_TRUNCATED',
        'Kết quả AI bị cắt ngắn vì vượt giới hạn đầu ra của model.',
        {
          provider: this.id,
          reason: finish,
          suggestion: 'Giảm số lượng kết quả hoặc rút gọn yêu cầu.',
        },
      );
  }

  async generateJSON(prompt: string, image?: AIInputImage): Promise<unknown> {
    this.validateConfiguration(image ? 'vision' : 'text');
    const parts: Part[] = [{ text: prompt }];
    if (image) {
      const data = image.base64.includes(',')
        ? image.base64.slice(image.base64.indexOf(',') + 1)
        : image.base64;
      parts.push({ inlineData: { mimeType: image.mimeType, data } });
    }
    const response = await this.genai.models.generateContent({
      model: image ? this.modelMultimodal : this.modelText,
      contents: [{ role: 'user', parts }],
    });
    this.assertResponse(response);
    const text = response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('');
    return parseAIJSON(text);
  }

  async generateImage(prompt: string): Promise<Buffer> {
    const response = await this.generateImageContent(prompt);
    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }
    throw new Error(`No image returned from ${this.id}`);
  }

  async replaceBackground(
    params: BackgroundReplacementParams,
  ): Promise<GeneratedImage> {
    const imagePart = (image: AIInputImage): Part => ({
      inlineData: {
        mimeType: image.mimeType,
        data: image.base64.includes(',')
          ? image.base64.slice(image.base64.indexOf(',') + 1)
          : image.base64,
      },
    });
    const response = await this.generateImageContent([
      {
        role: 'user',
        parts: [
          {
            text: `Replace the background of the product in IMAGE 1 using ONLY the background/environment from IMAGE 2. Output ONE finished product photograph.
IMAGE 1 is the source of truth for the product. Preserve its exact identity, design, shape, proportions, material, colors, texture, print, logo and text. Preserve the product's camera angle and its full visible details. Do not redesign, repaint, stylize or add elements to the product.
IMAGE 2 is a BACKGROUND reference, not a product or surface-design reference. Recreate its scene, layout, surfaces, colors and perspective as closely as possible. Remove the original foreground product/subject, people, captions and watermarks from IMAGE 2 before placing the product from IMAGE 1. Never copy its product, pattern, logo or text onto IMAGE 1.
Remove the original background from IMAGE 1 and realistically place that same product into IMAGE 2's environment. Match lighting, contact shadows, reflections, scale and depth while preserving the product. Keep the product clearly visible and do not crop it. Do not add text or watermarks.
Variation ${params.variationIndex ?? 1}: use only subtle placement/lighting variation; preserve the reference background and product identity.
Additional user preferences (apply only when compatible with preserving the product and reference scene): ${params.instructions?.trim() || 'None.'}`,
          },
          { text: 'IMAGE 1 — ORIGINAL PRODUCT:' },
          imagePart(params.productImage),
          { text: 'IMAGE 2 — BACKGROUND REFERENCE:' },
          imagePart(params.backgroundImage),
        ],
      },
    ]);
    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data)
        return {
          buffer: Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType || 'image/png',
        };
    }
    throw new Error(`No image returned from ${this.id}`);
  }

  async generateImagesFromReferalImages(
    params: ReferenceImagesParams,
  ): Promise<Buffer[]> {
    const { productImageBase64, productMimeType, referenceImages } = params;

    const normalizeBase64 = (b64: string) =>
      b64.includes(',') ? b64.split(',')[1] : b64;

    const parts: Part[] = [];

    parts.push({
      text: `
      Create ONE edited product image (variation ${params.variationIndex ?? 1}).
      Edit the FIRST image: preserve the product type, structure, proportions, materials and camera perspective.
      Use the reference images to guide an original surface design on the product's existing design area.
      Adapt the design to the product surface, curvature and perspective; do not assume the product is a shirt.
      Use a clean neutral studio background with realistic lighting and subtle shadow.
      Do not add text, logos or watermarks. Return one image.
      `,
    });

    parts.push({ text: 'Đây là ảnh mẫu sản phẩm gốc: ' });
    parts.push({
      inlineData: {
        mimeType: productMimeType,
        data: normalizeBase64(productImageBase64),
      },
    });

    if (referenceImages?.length) {
      parts.push({
        text: 'The following images are design references. Adapt their visual themes into a coherent original product design.',
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

    const response = await this.generateImageContent([{ role: 'user', parts }]);

    const resultParts = response.candidates?.[0]?.content?.parts;
    if (!resultParts) {
      throw new Error(`No content returned from ${this.id}`);
    }

    const images: Buffer[] = [];
    for (const part of resultParts) {
      if (part.inlineData?.data) {
        images.push(Buffer.from(part.inlineData.data, 'base64'));
      }
    }

    if (!images.length) {
      throw new Error(`No images returned from ${this.id}`);
    }

    return images;
  }

  async editImage(params: EditImageParams): Promise<Buffer> {
    const base64Data = params.base64Image.includes(',')
      ? params.base64Image.split(',')[1]
      : params.base64Image;

    const response = await this.generateImageContent([
      {
        role: 'user',
        parts: [
          { text: params.prompt },
          { inlineData: { mimeType: params.mimeType, data: base64Data } },
        ],
      },
    ]);

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts) {
      throw new Error(`No content returned from ${this.id}`);
    }

    for (const part of parts) {
      if (part.inlineData?.data) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }

    throw new Error(`No image returned from ${this.id}`);
  }
}
