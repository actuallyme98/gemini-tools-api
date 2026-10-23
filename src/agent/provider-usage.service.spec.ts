import { ConfigService } from '@nestjs/config';
import { ProviderUsageService } from './provider-usage.service';

describe('provider balance and usage', () => {
  const shopKey = 'private-shop-key';
  const textKey = 'private-text-key';
  const create = (settings: Record<string, unknown> = {}) =>
    new ProviderUsageService(new ConfigService(settings));
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes real provider formats, omits private account details and coalesces cached requests', async () => {
    fetchMock.mockImplementation((url: URL) =>
      Promise.resolve(
        Response.json(
          url.hostname === 'api.shopaikey.com'
            ? {
                total: 70,
                used: 28.93,
                balance: 41.07,
                name: 'private-account',
                token_name: shopKey,
              }
            : {
                balance: 174.54555665,
                totalSpent: 3.95444335,
                spendLimit: null,
                name: textKey,
                modelUsage: { private: {} },
              },
        ),
      ),
    );
    const service = create({
      SHOPAIKEY_API_KEY: shopKey,
      VYCEAI_API_KEY: textKey,
      GEMINI_API_KEY: 'private-google-key',
    });
    const [a, b] = await Promise.all([service.usage(), service.usage()]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a.items[0]).toMatchObject({
      id: 'shopaikey',
      label: 'Provider 1',
      status: 'available',
      balance: 41.07,
      used: 28.93,
      total: 70,
      totalBasis: 'provider',
    });
    expect(a.items[0].usedPercent).toBeCloseTo((28.93 / 70) * 100);
    expect(a.items[1]).toMatchObject({
      id: 'vyceai',
      balance: 174.54555665,
      used: 3.95444335,
      total: 178.5,
      totalBasis: 'balance_plus_used',
    });
    expect(a.items[2]).toMatchObject({ id: 'gemini', status: 'unsupported' });
    expect(JSON.stringify(a)).not.toMatch(
      /private|token_name|modelUsage|spendLimit/,
    );
    const [shopURL, shopOptions] = fetchMock.mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(shopURL.origin + shopURL.pathname).toBe(
      'https://api.shopaikey.com/usage',
    );
    expect(shopURL.searchParams.get('apiKey')).toBe(shopKey);
    expect(shopOptions.redirect).toBe('error');
    expect(shopOptions.signal).toBeInstanceOf(AbortSignal);
    const [textURL, textOptions] = fetchMock.mock.calls[1] as [
      URL,
      RequestInit,
    ];
    expect(textURL.href).toBe('https://vyceai.com/v1/me');
    expect(textOptions.headers).toEqual({ Authorization: `Bearer ${textKey}` });
    await service.usage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
    await service.usage();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('does not call providers without configured credentials', async () => {
    expect((await create().usage()).items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('isolates failures and never exposes an upstream credential, raw URL or a fabricated zero balance', async () => {
    fetchMock.mockImplementation((url: URL) =>
      Promise.resolve(
        url.hostname === 'api.shopaikey.com'
          ? new Response(
              `private key ${shopKey} https://secret.example?apiKey=${shopKey}`,
              { status: 401 },
            )
          : Response.json({ balance: 5, totalSpent: 15 }),
      ),
    );
    const service = create({
      SHOPAIKEY_API_KEY: shopKey,
      VYCEAI_API_KEY: textKey,
    });
    const result = await service.usage();
    expect(result.items[0]).toMatchObject({
      status: 'error',
      code: 'PROVIDER_USAGE_HTTP_401',
    });
    expect(result.items[0]).not.toHaveProperty('balance');
    expect(result.items[1]).toMatchObject({
      status: 'available',
      usedPercent: 75,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret.example/);
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ total: 20, used: 15, balance: 5 })),
    );
    expect(
      (await service.usage()).items.every(
        (item) => item.status === 'available',
      ),
    ).toBe(true);
  });
  it.each([
    new Error(`Network error ${shopKey}`),
    new DOMException('Timeout', 'TimeoutError'),
  ])('returns a safe error for transport failures', async (error) => {
    fetchMock.mockRejectedValue(error);
    const item = (await create({ SHOPAIKEY_API_KEY: shopKey }).usage())
      .items[0];
    expect(item).toMatchObject({
      status: 'error',
      code: 'PROVIDER_USAGE_UNAVAILABLE',
    });
    expect(JSON.stringify(item)).not.toContain(shopKey);
    expect(item).not.toHaveProperty('usedPercent');
  });
  it('rejects invalid JSON and invalid monetary values', async () => {
    const service = create({ SHOPAIKEY_API_KEY: shopKey });
    for (const value of [null, '', true, 'NaN', 'Infinity', 'invalid']) {
      fetchMock.mockResolvedValue(Response.json({ balance: value }));
      expect((await service.usage()).items[0]).toMatchObject({
        status: 'error',
        code: 'PROVIDER_USAGE_INVALID',
      });
    }
    fetchMock.mockResolvedValue(new Response('invalid json'));
    expect((await service.usage()).items[0]).toMatchObject({
      status: 'error',
      code: 'PROVIDER_USAGE_UNAVAILABLE',
    });
  });
  it('accepts numeric strings without inventing usage when only a balance is available', async () => {
    fetchMock.mockResolvedValue(Response.json({ remaining: '12.50' }));
    const item = (await create({ SHOPAIKEY_API_KEY: shopKey }).usage())
      .items[0];
    expect(item).toMatchObject({ status: 'available', balance: 12.5 });
    expect(item).not.toHaveProperty('usedPercent');
  });
  it.each([
    { balance: 0, used: 50, total: 50 },
    { balance: -5, used: 55, total: 50 },
  ])(
    'keeps depleted or negative balances and bounds progress to 100%',
    async (payload) => {
      fetchMock.mockResolvedValue(Response.json(payload));
      expect(
        (await create({ SHOPAIKEY_API_KEY: shopKey }).usage()).items[0],
      ).toMatchObject({
        status: 'available',
        balance: payload.balance,
        usedPercent: 100,
      });
    },
  );
  it('shows no percentage for a zero total or a missing spending figure', async () => {
    for (const payload of [
      { total: 0, used: 0, balance: 0 },
      { total: 10, balance: 10 },
    ]) {
      fetchMock.mockResolvedValue(Response.json(payload));
      const item = (await create({ SHOPAIKEY_API_KEY: shopKey }).usage())
        .items[0];
      expect(item.status).toBe('available');
      expect(item).not.toHaveProperty('usedPercent');
    }
  });
});
