import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { VyceAIProvider } from './vyceai.provider';
import { BudgetService } from '../../agent/budget.service';
import { TextRouterService } from '../text-router.service';
import { ShopAIKeyProvider } from './shopaikey.provider';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
const answer = (content: string, finish_reason = 'stop') => ({
  choices: [{ finish_reason, message: { content } }],
});

describe('Internal VyceAI text routing', () => {
  const list = jest.fn();
  const create = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.mocked(OpenAI).mockImplementation(
      () =>
        ({
          models: { list },
          chat: { completions: { create } },
        }) as unknown as OpenAI,
    );
    list.mockResolvedValue({
      data: [
        { id: 'deepseek-v4.1' },
        { id: 'claude-sonnet-4-6' },
        { id: 'gpt-6-luna' },
        { id: 'gpt-image-1' },
      ],
    });
  });
  afterEach(() => jest.restoreAllMocks());
  const provider = () =>
    new VyceAIProvider(
      new ConfigService({
        VYCEAI_API_KEY: 'test-key',
        VYCEAI_HEALTH_TIMEOUT_MS: 2000,
      }),
    );
  it('discovers GPT before Claude, skips unhealthy GPT, and probes again before the next prompt', async () => {
    const vyceai = provider();
    create
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(answer('OK'))
      .mockResolvedValueOnce(answer('["first"]'));
    expect(await vyceai.generateJSON('first prompt')).toEqual(['first']);
    expect(
      create.mock.calls.map((call) => (call as [{ model: string }])[0].model),
    ).toEqual(['gpt-6-luna', 'claude-sonnet-4-6', 'claude-sonnet-4-6']);
    expect((create.mock.calls as unknown[][])[0][1]).toEqual({ timeout: 2000 });
    expect(
      ((create.mock.calls as unknown[][])[1][0] as { messages: unknown[] })
        .messages,
    ).toEqual([{ role: 'user', content: 'Reply with only OK.' }]);
    create
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(answer('OK'))
      .mockResolvedValueOnce(answer('["second"]'));
    expect(await vyceai.generateJSON('second prompt')).toEqual(['second']);
    expect(list).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(6);
    expect(jest.mocked(OpenAI)).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
        baseURL: 'https://vyceai.com/v1',
      }),
    );
  });
  it('never sends the real prompt to models that fail health', async () => {
    create.mockResolvedValue(answer('', 'length'));
    await expect(
      provider().generateJSON('private real prompt'),
    ).rejects.toThrow('No healthy');
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls)).not.toContain(
      'private real prompt',
    );
  });
  it('does not generate when model discovery fails', async () => {
    list.mockRejectedValue(new Error('unavailable'));
    await expect(provider().generateJSON('prompt')).rejects.toThrow(
      'unavailable',
    );
    expect(create).not.toHaveBeenCalled();
  });
  it('skips models without both health/text prices before making any paid probe', async () => {
    const budget = {
      hasPrice: jest.fn(({ model }: { model: string }) =>
        Promise.resolve(model === 'claude-sonnet-4-6'),
      ),
      call: jest.fn((_spec: unknown, task: () => unknown) => task()),
    };
    const vyceai = new VyceAIProvider(
      new ConfigService({ VYCEAI_API_KEY: 'test-key' }),
      budget as unknown as BudgetService,
    );
    create
      .mockResolvedValueOnce(answer('OK'))
      .mockResolvedValueOnce(answer('["priced model"]'));
    expect(await vyceai.generateJSON('prompt')).toEqual(['priced model']);
    expect(
      create.mock.calls.map((call) => (call as [{ model: string }])[0].model),
    ).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-6']);
  });
  it('falls back to ShopAIKey without sending a health call when all Vyce prices are missing', async () => {
    const budget = {
      hasPrice: jest.fn(() => Promise.resolve(false)),
      call: jest.fn(),
    };
    const vyceai = new VyceAIProvider(
      new ConfigService({ VYCEAI_API_KEY: 'test-key' }),
      budget as unknown as BudgetService,
    );
    const fallback = {
      generateJSON: jest.fn(() => Promise.resolve(['fallback'])),
    };
    const router = new TextRouterService(
      vyceai,
      fallback as unknown as ShopAIKeyProvider,
    );
    expect(await router.generateJSON('prompt')).toEqual(['fallback']);
    expect(create).not.toHaveBeenCalled();
    expect(budget.call).not.toHaveBeenCalled();
    expect(fallback.generateJSON).toHaveBeenCalledTimes(1);
  });
});
