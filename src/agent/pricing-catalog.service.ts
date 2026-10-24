import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../common/api-error';
import { BudgetService } from './budget.service';

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const rate = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000000
    ? v
    : undefined;
export function pricingRows(value: unknown) {
  const data = record(value);
  if (!Array.isArray(data.groups) || data.groups.length > 100)
    throw new ApiError(
      502,
      'PRICING_CATALOG_INVALID',
      'Bảng giá provider không hợp lệ.',
    );
  return data.groups.flatMap((raw: unknown) => {
    const group = record(raw);
    if (
      typeof group.name !== 'string' ||
      !Array.isArray(group.models) ||
      group.models.length > 2000
    )
      return [];
    const groupName = group.name.slice(0, 100);
    return group.models.flatMap((rawModel: unknown) => {
      const model = record(rawModel);
      if (
        typeof model.name !== 'string' ||
        model.name.length > 180 ||
        typeof model.quotaType !== 'number' ||
        ![0, 1].includes(model.quotaType)
      )
        return [];
      return [
        {
          group: groupName,
          model: model.name,
          quotaType: Number(model.quotaType),
          input: rate(model.input),
          output: rate(model.completion),
          price: rate(model.price),
          cacheRead: rate(model.cacheRead),
          cacheWrite: rate(model.cacheWrite),
        },
      ];
    });
  });
}

@Injectable()
export class PricingCatalogService {
  constructor(
    private readonly config: ConfigService,
    private readonly budget: BudgetService,
  ) {}
  async catalog() {
    const url = new URL(
      '/pricing',
      this.config.get<string>(
        'SHOPAIKEY_BASE_URL',
        'https://api.shopaikey.com',
      ),
    );
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new ApiError(
        503,
        'PRICING_CATALOG_UNAVAILABLE',
        'Chưa kết nối được bảng giá provider.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(
        502,
        'PRICING_CATALOG_UNAVAILABLE',
        'Provider chưa cung cấp bảng giá.',
      );
    }
    // Public catalog only; no API key is sent to the pricing endpoint.
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();
    if (!reader)
      throw new ApiError(502, 'PRICING_CATALOG_INVALID', 'Bảng giá rỗng.');
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 4_000_000)
          throw new ApiError(
            502,
            'PRICING_CATALOG_INVALID',
            'Bảng giá quá lớn.',
          );
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'PRICING_CATALOG_UNAVAILABLE',
        'Đọc bảng giá bị gián đoạn. Hãy thử lại.',
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = JSON.parse(bytes);
    } catch {
      throw new ApiError(
        502,
        'PRICING_CATALOG_INVALID',
        'Không đọc được bảng giá.',
      );
    }
    return {
      provider: 'shopaikey',
      source: url.toString(),
      checkedAt: new Date().toISOString(),
      version:
        typeof record(body).pricing_version === 'string'
          ? (record(body).pricing_version as string).slice(0, 100)
          : '',
      rows: pricingRows(body),
      warning:
        'Giá phụ thuộc nhóm của API key. Xác minh đơn vị tiền và đơn vị tính với tài khoản trước khi áp dụng. Không tự nhân lại hệ số nhóm; giá công bố có thể đã gồm hệ số. Không tự chuyển credit thành USD.',
    };
  }
  async readiness() {
    const policy = await this.budget.policy();
    const unresolved = policy.prices.filter(
      (p) =>
        p.requestUsd === undefined &&
        p.imageUsd === undefined &&
        (p.inputUsdPerMillion === undefined ||
          p.outputUsdPerMillion === undefined),
    );
    return {
      configured: policy.prices.length,
      ready: policy.prices.length > 0 && unresolved.length === 0,
      unpriced: unresolved.map((p) => ({
        provider: p.provider,
        model: p.model,
        operation: p.operation,
      })),
      message: policy.prices.length
        ? 'Chỉ những model/tác vụ đã cấu hình mới được gọi. Kiểm thử thực tế và đối soát trước khi mở rộng.'
        : 'Chưa có bảng giá. Tác vụ AI bị chặn trước khi gọi provider.',
    };
  }
}
