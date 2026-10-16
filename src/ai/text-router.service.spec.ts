import { Logger } from '@nestjs/common';
import { TextRouterService } from './text-router.service';
import { VyceAIProvider } from './providers/vyceai.provider';
import { ShopAIKeyProvider } from './providers/shopaikey.provider';

describe('Text provider failover', () => {
  afterEach(() => jest.restoreAllMocks());
  const setup = () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const vyceai = {
      generateJSON: jest.fn(),
      validateConfiguration: jest.fn(),
    };
    const shopaikey = {
      id: 'shopaikey',
      name: 'ShopAIKey',
      generateJSON: jest.fn(),
      validateConfiguration: jest.fn(),
    };
    return {
      vyceai,
      shopaikey,
      router: new TextRouterService(
        vyceai as unknown as VyceAIProvider,
        shopaikey as unknown as ShopAIKeyProvider,
      ),
    };
  };
  it('keeps healthy preferred output without calling fallback', async () => {
    const { router, vyceai, shopaikey } = setup();
    vyceai.generateJSON.mockResolvedValue(['primary']);
    expect(await router.generateJSON('prompt')).toEqual(['primary']);
    expect(shopaikey.generateJSON).not.toHaveBeenCalled();
  });
  it('uses ShopAIKey when discovery, health, authentication or generation fails', async () => {
    const { router, vyceai, shopaikey } = setup();
    vyceai.generateJSON.mockRejectedValue(new Error('unavailable'));
    shopaikey.generateJSON.mockResolvedValue(['fallback']);
    expect(await router.generateJSON('prompt')).toEqual(['fallback']);
    expect(shopaikey.generateJSON).toHaveBeenCalledWith('prompt');
    expect(vyceai.generateJSON).toHaveBeenCalledTimes(1);
  });
  it('reports the fallback provider error and performs no internal retries', async () => {
    const { router, vyceai, shopaikey } = setup();
    vyceai.generateJSON.mockRejectedValue(new Error('offline'));
    shopaikey.generateJSON.mockRejectedValue(
      Object.assign(new Error('invalid api key'), { status: 401 }),
    );
    await expect(router.generateJSON('prompt')).rejects.toMatchObject({
      response: { code: 'AI_AUTHENTICATION_FAILED', provider: 'shopaikey' },
    });
    expect(shopaikey.generateJSON).toHaveBeenCalledTimes(1);
  });
});
