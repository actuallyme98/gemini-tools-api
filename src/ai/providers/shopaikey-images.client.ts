import { ConfigService } from '@nestjs/config';
import type { AIInputImage, GeneratedImage } from '../ai-provider';
import { ApiError } from '../../common/api-error';
import { imageMimeType } from '../../utils/image.util';
import { AuditLogService } from '../../audit/audit-log.service';
import { withRetry } from '../../utils/function.util';
import { sanitizeErrorMessage } from '../../common/error-sanitizer';
import { BudgetService } from '../../agent/budget.service';
import { responseUsage } from '../../agent/budget.util';

export function imageModelFamily(
  id: string,
): 'gemini' | 'gpt' | 'grok' | undefined {
  if (id.length > 128) return undefined;
  if (
    /^gemini-[a-z0-9._-]*image[a-z0-9._-]*$/.test(id) ||
    /^gemini-nano-banana-[a-z0-9][a-z0-9._-]*$/.test(id)
  )
    return 'gemini';
  if (/^gpt-image-[a-z0-9][a-z0-9._-]*$/.test(id)) return 'gpt';
  if (/^grok-imagine-image(?:-[a-z0-9][a-z0-9._-]*)?$/.test(id)) return 'grok';
  return undefined;
}

/** ShopAIKey's image APIs; credentials and source images remain on the backend. */
export class ShopAIKeyImagesClient {
  constructor(
    private readonly config: ConfigService,
    private readonly audit?: AuditLogService,
    private readonly budget?: BudgetService,
  ) {}

  async download(rawUrl: string): Promise<GeneratedImage> {
    const allowed = this.config
      .get<string>(
        'SHOPAIKEY_IMAGE_DOWNLOAD_HOSTS',
        'image.chr1.com,direct.shopaikey.com,api.shopaikey.com',
      )
      .split(',')
      .map((host) => host.trim().toLowerCase());
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ApiError(
        502,
        'AI_IMAGE_URL_UNTRUSTED',
        'Provider trả về địa chỉ ảnh không hợp lệ.',
      );
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !allowed.includes(url.hostname.toLowerCase())
    )
      throw new ApiError(
        502,
        'AI_IMAGE_URL_UNTRUSTED',
        'Nguồn tải ảnh của provider chưa được cho phép trên máy chủ.',
        {
          provider: 'shopaikey',
          reason: `Image host: ${url.hostname}`,
          suggestion:
            'Liên hệ quản trị viên kèm mã yêu cầu để kiểm tra nguồn ảnh.',
        },
      );
    try {
      const image = await withRetry(
        async () => {
          // Exact host allowlist, no credentials and no redirects: never fetch arbitrary model-provided URLs.
          const response = await fetch(url.href, {
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw Object.assign(
              new Error(`Image download HTTP ${response.status}`),
              { status: response.status },
            );
          }
          const maxBytes = 32 * 1024 * 1024;
          if (Number(response.headers.get('content-length')) > maxBytes) {
            await response.body?.cancel();
            throw new ApiError(
              502,
              'AI_IMAGE_TOO_LARGE',
              'Ảnh provider trả về vượt giới hạn 32MB.',
            );
          }
          if (!response.body)
            throw new ApiError(
              502,
              'AI_IMAGE_DOWNLOAD_INVALID',
              'Provider trả về ảnh rỗng.',
            );
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > maxBytes) {
                await reader.cancel();
                throw new ApiError(
                  502,
                  'AI_IMAGE_TOO_LARGE',
                  'Ảnh provider trả về vượt giới hạn 32MB.',
                );
              }
              chunks.push(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
          const buffer = Buffer.concat(chunks);
          const mimeType = imageMimeType(buffer);
          if (!mimeType)
            throw new ApiError(
              502,
              'AI_IMAGE_DOWNLOAD_INVALID',
              'Nội dung tải từ provider không phải ảnh PNG, JPEG hoặc WebP hợp lệ.',
            );
          return { buffer, mimeType };
        },
        { retries: 2, delayMs: 500 },
      );
      await this.audit?.write('ai_image_downloaded', {
        provider: 'shopaikey',
        host: url.hostname,
        bytes: image.buffer.length,
        mimeType: image.mimeType,
      });
      return image;
    } catch (error) {
      await this.audit?.write('ai_image_download_failed', {
        provider: 'shopaikey',
        host: url.hostname,
        reason:
          error instanceof Error
            ? sanitizeErrorMessage(error.message)
            : 'Unknown image download error',
      });
      if (error instanceof ApiError) throw error;
      // Download retries must not repeat a paid model generation.
      throw new ApiError(
        502,
        'AI_IMAGE_DOWNLOAD_FAILED',
        'Provider đã trả link ảnh nhưng máy chủ không tải được ảnh.',
        {
          provider: 'shopaikey',
          reason:
            error instanceof Error
              ? sanitizeErrorMessage(error.message)
              : undefined,
          suggestion:
            'Liên hệ quản trị viên kèm mã yêu cầu để kiểm tra ảnh đã tạo.',
        },
      );
    }
  }

  async generate(
    model: string,
    prompt: string,
    images: AIInputImage[],
  ): Promise<GeneratedImage> {
    const family = imageModelFamily(model);
    const maxImages = family === 'grok' ? 5 : 16;
    if (images.length > maxImages)
      throw new ApiError(
        400,
        'AI_INPUT_IMAGE_LIMIT',
        `Model ${model} nhận tối đa ${maxImages} ảnh, bao gồm ảnh sản phẩm gốc.`,
        {
          provider: 'shopaikey',
          suggestion: `Giảm còn tối đa ${maxImages - 1} ảnh tham chiếu hoặc chọn model khác.`,
        },
      );
    const base = this.config
      .get<string>('SHOPAIKEY_IMAGE_BASE_URL', 'https://direct.shopaikey.com')
      .replace(/\/$/, '');
    const apiKey = this.config.getOrThrow<string>('SHOPAIKEY_API_KEY');
    let body: FormData | string;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    if (images.length) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('n', '1');
      form.append('response_format', 'b64_json');
      if (family === 'gpt') form.append('output_format', 'png');
      for (const [index, image] of images.entries()) {
        const data = image.base64.replace(/^data:[^,]*,/, '');
        const extension =
          image.mimeType === 'image/jpeg'
            ? 'jpg'
            : image.mimeType === 'image/webp'
              ? 'webp'
              : 'png';
        form.append(
          images.length === 1 ? 'image' : 'image[]',
          new Blob([Uint8Array.from(Buffer.from(data, 'base64'))], {
            type: image.mimeType,
          }),
          `input-${index + 1}.${extension}`,
        );
      }
      body = form;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        model,
        prompt,
        n: 1,
        response_format: 'b64_json',
        ...(family === 'gpt' ? { output_format: 'png' } : {}),
      });
    }
    await this.audit?.aiRequest(
      'shopaikey',
      model,
      images.length ? 'images/edits' : 'images/generations',
      [
        { text: prompt },
        ...images.map((image) => ({
          buffer: Buffer.from(
            image.base64.replace(/^data:[^,]*,/, ''),
            'base64',
          ),
          mimeType: image.mimeType,
        })),
      ],
    );
    const generate = async () => {
      const response = await fetch(
        `${base}/v1/images/${images.length ? 'edits' : 'generations'}`,
        {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(
            this.config.get<number>('SHOPAIKEY_IMAGE_TIMEOUT_MS', 180000),
          ),
        },
      );
      let result: {
        data?: { b64_json?: unknown; url?: unknown }[];
        error?: { message?: unknown };
      };
      try {
        result = (await response.json()) as typeof result;
      } catch {
        throw Object.assign(
          new Error('AI provider returned an invalid image response'),
          { status: response.status >= 400 ? response.status : undefined },
        );
      }
      if (!response.ok || result?.error)
        throw Object.assign(
          new Error(
            typeof result?.error?.message === 'string'
              ? result.error.message
              : 'AI image request failed',
          ),
          { status: response.ok ? 502 : response.status },
        );
      return result;
    };
    const result = this.budget
      ? await this.budget.call(
          { provider: 'shopaikey', model, operation: 'image' },
          generate,
          (response) =>
            responseUsage(response, 'openai', response.data?.length),
        )
      : await generate();
    const encoded = result?.data?.[0]?.b64_json;
    if (!encoded && typeof result?.data?.[0]?.url === 'string')
      return this.download(result.data[0].url);
    if (
      typeof encoded !== 'string' ||
      !encoded ||
      encoded.length > 48 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw new Error('AI provider returned no valid base64 image');
    const buffer = Buffer.from(encoded, 'base64');
    const mimeType = imageMimeType(buffer);
    if (!mimeType)
      throw new Error('AI provider returned an unsupported image format');
    return { buffer, mimeType };
  }
}
