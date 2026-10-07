import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { VyceAIProvider } from './vyceai.provider';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));

describe('VyceAIProvider', () => {
  const create = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(OpenAI)
      .mockImplementation(
        () => ({ chat: { completions: { create } } }) as unknown as OpenAI,
      );
    create.mockResolvedValue({
      choices: [{ message: { content: '["Studio"]' } }],
    });
  });

  it('uses the VyceAI endpoint and selected model with the existing SDK', async () => {
    const provider = new VyceAIProvider(
      new ConfigService({
        VYCEAI_API_KEY: 'test-key',
        VYCEAI_MODEL_TEXT: 'deepseek-v4.1',
      }),
    );
    expect(OpenAI).not.toHaveBeenCalled();
    expect(await provider.generateJSON('Generate prompts')).toEqual(['Studio']);
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: 'https://vyceai.com/v1',
      timeout: 60000,
      maxRetries: 0,
    });
    expect(create).toHaveBeenCalledWith({
      model: 'deepseek-v4.1',
      messages: [
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: 'Generate prompts' },
      ],
    });
  });

  it('allows custom endpoint and timeout and reuses the client', async () => {
    const provider = new VyceAIProvider(
      new ConfigService({
        VYCEAI_API_KEY: 'test-key',
        VYCEAI_MODEL_TEXT: 'custom-model',
        VYCEAI_BASE_URL: 'https://gateway.example/v1',
        VYCEAI_TIMEOUT_MS: 30000,
      }),
    );
    await provider.generateJSON('First');
    await provider.generateJSON('Second');
    expect(OpenAI).toHaveBeenCalledTimes(1);
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://gateway.example/v1',
        timeout: 30000,
      }),
    );
  });

  it('sends images only when vision is explicitly enabled and uses its separate model', async () => {
    const provider = new VyceAIProvider(
      new ConfigService({
        VYCEAI_API_KEY: 'test-key',
        VYCEAI_VISION_ENABLED: true,
        VYCEAI_MODEL_VISION: 'vision-model',
      }),
    );
    create.mockResolvedValue({
      choices: [{ message: { content: '{"productType":"shirt"}' } }],
    });
    await provider.generateJSON('Analyze', {
      base64: 'data:image/png;base64,aW1hZ2U=',
      mimeType: 'image/png',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'vision-model',
        messages: [
          expect.any(Object),
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
              },
            ],
          },
        ],
      }),
    );
  });

  it('rejects disabled vision, missing credentials and missing models before any request', async () => {
    const provider = new VyceAIProvider(new ConfigService({}));
    await expect(
      provider.generateJSON('Analyze', {
        base64: 'aW1hZ2U=',
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('does not support');
    expect(() => provider.validateConfiguration('text')).toThrow(
      'VYCEAI_API_KEY',
    );
    const missingModel = new VyceAIProvider(
      new ConfigService({ VYCEAI_API_KEY: 'test-key' }),
    );
    expect(() => missingModel.validateConfiguration('text')).toThrow(
      'VYCEAI_MODEL_TEXT',
    );
    const missingVisionModel = new VyceAIProvider(
      new ConfigService({
        VYCEAI_API_KEY: 'test-key',
        VYCEAI_VISION_ENABLED: true,
      }),
    );
    expect(() => missingVisionModel.validateConfiguration('vision')).toThrow(
      'VYCEAI_MODEL_VISION',
    );
    expect(create).not.toHaveBeenCalled();
    expect(OpenAI).not.toHaveBeenCalled();
  });

  it.each([null, 'invalid JSON', undefined])(
    'rejects empty or malformed completion %j',
    async (content) => {
      const provider = new VyceAIProvider(
        new ConfigService({
          VYCEAI_API_KEY: 'test-key',
          VYCEAI_MODEL_TEXT: 'model',
        }),
      );
      create.mockResolvedValue({ choices: [{ message: { content } }] });
      await expect(provider.generateJSON('Generate')).rejects.toThrow('JSON');
    },
  );
});
