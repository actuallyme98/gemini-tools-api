import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ProviderUsage = {
  id: string;
  label: string;
  status: 'available' | 'unsupported' | 'error';
  balance?: number;
  used?: number;
  total?: number;
  totalBasis?: 'provider' | 'balance_plus_used';
  usedPercent?: number;
  checkedAt?: string;
  code?: string;
  message?: string;
};
type UsageSnapshot = { items: ProviderUsage[]; generatedAt: string };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function amount(value: unknown) {
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()))
    value = Number(value);
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

@Injectable()
export class ProviderUsageService {
  private cache?: { expires: number; data: UsageSnapshot };
  private pending?: Promise<UsageSnapshot>;
  constructor(private readonly config: ConfigService) {}

  async usage(): Promise<UsageSnapshot> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.data;
    if (this.pending !== undefined) return this.pending;
    this.pending = this.load();
    try {
      const data = await this.pending;
      if (data.items.every((item) => item.status !== 'error'))
        this.cache = { expires: Date.now() + 60000, data };
      return data;
    } finally {
      this.pending = undefined;
    }
  }

  private async load(): Promise<UsageSnapshot> {
    const requests: Promise<ProviderUsage>[] = [];
    for (const [id, label, keyName] of [
      ['shopaikey', 'Provider 1', 'SHOPAIKEY_API_KEY'],
      ['vyceai', 'Provider văn bản', 'VYCEAI_API_KEY'],
    ]) {
      const key = this.config.get<string>(keyName);
      if (key) requests.push(this.lookup(id, label, key));
    }
    if (this.config.get<string>('GEMINI_API_KEY'))
      requests.push(
        Promise.resolve({
          id: 'gemini',
          label: 'Provider 2',
          status: 'unsupported',
          message: 'Kết nối này chưa hỗ trợ truy vấn số dư bằng API key.',
        }),
      );
    return {
      items: await Promise.all(requests),
      generatedAt: new Date().toISOString(),
    };
  }

  private async lookup(
    id: string,
    label: string,
    key: string,
  ): Promise<ProviderUsage> {
    try {
      const base = this.config.get<string>(
        id === 'shopaikey' ? 'SHOPAIKEY_BASE_URL' : 'VYCEAI_BASE_URL',
        id === 'shopaikey'
          ? 'https://api.shopaikey.com'
          : 'https://vyceai.com/v1',
      );
      const url =
        id === 'shopaikey'
          ? new URL('/usage', base)
          : new URL(base.replace(/\/+$/, '') + '/me');
      if (id === 'shopaikey') url.searchParams.set('apiKey', key);
      // The ShopAIKey query parameter is required by its usage API; never log the URL or raw errors.
      const response = await fetch(url, {
        headers: id === 'vyceai' ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          id,
          label,
          status: 'error',
          code: `PROVIDER_USAGE_HTTP_${response.status}`,
          message:
            response.status === 401 || response.status === 403
              ? 'Provider từ chối quyền xem số dư. Kiểm tra key và quyền truy cập.'
              : 'Chưa lấy được số dư từ provider. Vui lòng thử lại.',
        };
      }
      const body = record(await response.json());
      const balance = amount(body.balance ?? body.remaining);
      const used = amount(id === 'shopaikey' ? body.used : body.totalSpent);
      const providerTotal = id === 'shopaikey' ? amount(body.total) : undefined;
      if (
        balance === undefined ||
        (used !== undefined && used < 0) ||
        (providerTotal !== undefined && providerTotal < 0)
      )
        return {
          id,
          label,
          status: 'error',
          code: 'PROVIDER_USAGE_INVALID',
          message: 'Provider trả dữ liệu số dư không hợp lệ.',
        };
      const total =
        providerTotal ?? (used === undefined ? undefined : balance + used);
      return {
        id,
        label,
        status: 'available',
        balance,
        used,
        ...(total !== undefined &&
        Number.isFinite(total) &&
        total > 0 &&
        used !== undefined
          ? {
              total,
              totalBasis:
                providerTotal === undefined ? 'balance_plus_used' : 'provider',
              usedPercent: Math.max(0, Math.min(100, (used / total) * 100)),
            }
          : {}),
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        id,
        label,
        status: 'error',
        code: 'PROVIDER_USAGE_UNAVAILABLE',
        message:
          'Không kết nối được dịch vụ số dư hoặc phản hồi không hợp lệ. Vui lòng thử lại.',
      };
    }
  }
}
