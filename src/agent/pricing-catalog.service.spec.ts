import { pricingRows, PricingCatalogService } from './pricing-catalog.service';
import { ConfigService } from '@nestjs/config';
import type { BudgetService } from './budget.service';
describe('public pricing catalog', () => {
  it('keeps groups distinct and never multiplies or guesses monetary units', () => {
    const rows = pricingRows({
      groups: [
        {
          name: 'cheap',
          ratio: 2,
          models: [{ name: 'image-model', price: 0.3, quotaType: 1 }],
        },
        {
          name: 'fast',
          models: [
            { name: 'image-model', price: 0.6, quotaType: 1 },
            { name: 'unknown', price: -1, quotaType: 4 },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.group, r.price])).toEqual([
      ['cheap', 0.3],
      ['fast', 0.6],
    ]);
  });
  it('rejects an unexpected provider response', () =>
    expect(() => pricingRows({ models: [] })).toThrow());
  it('fetches only the public endpoint without forwarding keys or auto-writing prices', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        pricing_version: 'version',
        groups: [
          {
            name: 'account-group',
            models: [{ name: 'image', quotaType: 1, price: 0.3 }],
          },
        ],
      }),
    );
    try {
      const budget = { policy: jest.fn(() => Promise.resolve({ prices: [] })) };
      const service = new PricingCatalogService(
        new ConfigService({ SHOPAIKEY_API_KEY: 'private-key' }),
        budget as unknown as BudgetService,
      );
      const result = await service.catalog();
      expect(result.rows[0].price).toBe(0.3);
      const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe('https://api.shopaikey.com/pricing');
      expect(options.headers).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('private-key');
      expect((await service.readiness()).ready).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
