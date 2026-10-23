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
import { sanitizeErrorMessage } from '../../common/error-sanitizer';
import { AuditLogService, type AuditPart } from '../../audit/audit-log.service';
import { BudgetService } from '../../agent/budget.service';
import { responseUsage } from '../../agent/budget.util';

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
    private readonly audit?: AuditLogService,
    private readonly budget?: BudgetService,
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

  protected async generateImageContent(
    contents: string | { role: string; parts: Part[] }[],
    imageModel?: string,
  ): Promise<GenerateContentResponse> {
    this.validateConfiguration('image');
    await this.auditContents(
      imageModel ?? this.modelImage,
      'generateContent:image',
      contents,
    );
    const generate = () =>
      this.imageGenai.models.generateContent({
        model: imageModel ?? this.modelImage,
        contents,
        ...(this.providerConfig.imageResponseModalities
          ? { config: { responseModalities: ['TEXT', 'IMAGE'] } }
          : {}),
      });
    let response = this.budget
      ? await this.budget.call(
          {
            provider: this.id,
            model: imageModel ?? this.modelImage,
            operation: 'image',
          },
          generate,
          (result) =>
            responseUsage(
              result,
              'genai',
              result.candidates
                ?.flatMap((candidate) => candidate.content?.parts ?? [])
                .filter((part) => !part.thought && !!part.inlineData?.data)
                .length || undefined,
            ),
        )
      : await generate();
    await this.audit?.write('ai_response', {
      provider: this.id,
      model: imageModel ?? this.modelImage,
      responseId: response.responseId,
      modelVersion: response.modelVersion,
      promptFeedback: response.promptFeedback,
      candidates: response.candidates?.slice(0, 8).map((candidate) => ({
        finishReason: candidate.finishReason,
        finishMessage: candidate.finishMessage
          ? sanitizeErrorMessage(candidate.finishMessage)
          : undefined,
        safetyRatings: candidate.safetyRatings,
        parts: candidate.content?.parts?.slice(0, 20).map((part) =>
          part.thought
            ? { type: 'thought', omitted: true }
            : {
                text: part.text
                  ? sanitizeErrorMessage(part.text, 2000)
                  : undefined,
                image: part.inlineData
                  ? {
                      mimeType: part.inlineData.mimeType,
                      base64Length: part.inlineData.data?.length,
                    }
                  : undefined,
                file: part.fileData
                  ? { mimeType: part.fileData.mimeType, present: true }
                  : undefined,
              },
        ),
      })),
    });
    this.assertResponse(response);
    response = await this.normalizeImageResponse(response);
    const imageCandidate = response.candidates?.find((candidate) =>
      candidate.content?.parts?.some(
        (part) =>
          !part.thought &&
          part.inlineData?.data &&
          /^image\//.test(part.inlineData.mimeType || 'image/png'),
      ),
    );
    if (imageCandidate) {
      if (imageCandidate.content)
        imageCandidate.content.parts = imageCandidate.content.parts?.filter(
          (part) => !part.thought,
        );
      response.candidates = [imageCandidate];
    }
    this.assertResponse(response);
    if (!imageCandidate) {
      const candidate = response.candidates?.[0];
      const finish = String(candidate?.finishReason || 'EMPTY_RESPONSE');
      const explanation = candidate?.content?.parts
        ?.filter((part) => !part.thought)
        .map((part) => part.text || '')
        .join(' ')
        .trim();
      throw new ApiError(
        502,
        'AI_NO_IMAGE',
        'Model đã phản hồi nhưng không tạo ảnh cho yêu cầu này.',
        {
          provider: this.id,
          reason: sanitizeErrorMessage(
            [finish, candidate?.finishMessage, explanation]
              .filter(Boolean)
              .join(': '),
            600,
          ),
          suggestion:
            'Kiểm tra nội dung phản hồi, điều chỉnh prompt hoặc thử lại riêng ảnh này. Ảnh đã thành công vẫn được giữ lại.',
        },
      );
    }
    return response;
  }

  protected normalizeImageResponse(
    response: GenerateContentResponse,
  ): Promise<GenerateContentResponse> {
    return Promise.resolve(response);
  }

  private async auditContents(
    model: string,
    transport: string,
    contents: string | { role: string; parts: Part[] }[],
  ) {
    if (!this.audit) return;
    const parts: AuditPart[] = [];
    for (const part of typeof contents === 'string'
      ? [{ text: contents }]
      : contents.flatMap((content) => content.parts)) {
      if (part.text !== undefined) parts.push({ text: part.text });
      if (part.inlineData?.data)
        parts.push({
          buffer: Buffer.from(
            part.inlineData.data.replace(/^data:[^,]*,/, ''),
            'base64',
          ),
          mimeType: part.inlineData.mimeType || 'image/png',
        });
    }
    await this.audit.aiRequest(this.id, model, transport, parts);
  }

  private assertResponse(response: GenerateContentResponse): void {
    const blocked = response.promptFeedback?.blockReason;
    const finish = String(response.candidates?.[0]?.finishReason || '');
    if (
      blocked ||
      [
        'SAFETY',
        'IMAGE_SAFETY',
        'IMAGE_PROHIBITED_CONTENT',
        'IMAGE_RECITATION',
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
    await this.auditContents(
      image ? this.modelMultimodal : this.modelText,
      'generateContent:json',
      [{ role: 'user', parts }],
    );
    const generate = () =>
      this.genai.models.generateContent({
        model: image ? this.modelMultimodal : this.modelText,
        contents: [{ role: 'user', parts }],
      });
    const response = this.budget
      ? await this.budget.call(
          {
            provider: this.id,
            model: image ? this.modelMultimodal : this.modelText,
            operation: image ? 'vision' : 'text',
          },
          generate,
          (result) => responseUsage(result, 'genai'),
        )
      : await generate();
    this.assertResponse(response);
    const text = response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('');
    return parseAIJSON(text);
  }

  async generateImage(prompt: string, imageModel?: string): Promise<Buffer> {
    const response = await this.generateImageContent(prompt, imageModel);
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
    const response = await this.generateImageContent(
      [
        {
          role: 'user',
          parts: [
            {
              text: params.instructions,
            },
            imagePart(params.backgroundImage),
            imagePart(params.productImage),
          ],
        },
      ],
      params.imageModel,
    );
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

    const response = await this.generateImageContent(
      [{ role: 'user', parts }],
      params.imageModel,
    );

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

    const response = await this.generateImageContent(
      [
        {
          role: 'user',
          parts: [
            { text: params.prompt },
            { inlineData: { mimeType: params.mimeType, data: base64Data } },
          ],
        },
      ],
      params.imageModel,
    );

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
