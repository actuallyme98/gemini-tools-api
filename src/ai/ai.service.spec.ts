import { ConfigService } from '@nestjs/config';
import { AIService } from './ai.service';
import type { AIProvider } from './ai-provider';
import type { ImageAnalysis } from './types';

const analysis: ImageAnalysis = {
  productCategory: 'apparel',
  productType: 'shirt',
  displayMode: 'product_only',
  primaryColors: ['white'],
  pattern: 'plain',
  styleKeywords: ['minimal'],
  mood: 'calm',
  audience: 'adults',
  material: {
    main: 'cotton',
    details: '',
    texture: 'soft',
    weightOrThickness: 'light',
    flexibility: 'flexible',
    breathability: 'high',
    seasonSuitability: ['summer'],
  },
};

function provider(id: string, capabilities: AIProvider['capabilities']) {
  return {
    id,
    capabilities,
    validateConfiguration: jest.fn(),
    generateJSON: jest.fn(),
    generateImage: jest.fn().mockResolvedValue(Buffer.from('generated')),
    editImage: jest.fn().mockResolvedValue(Buffer.from('edited')),
    generateImagesFromReferalImages: jest
      .fn()
      .mockResolvedValue([Buffer.from('reference')]),
  } satisfies AIProvider;
}

describe('AIService provider routing', () => {
  const backgroundParams = {
    productImage: { base64: 'cHJvZHVjdA==', mimeType: 'image/png' },
    backgroundImage: { base64: 'c2NlbmU=', mimeType: 'image/png' },
    variationIndex: 1,
  };
  it('rejects a provider missing background replacement without falling back', () => {
    const legacy = provider('legacy', ['text', 'vision', 'image']);
    const service = new AIService(new ConfigService({}), [gemini, legacy]);
    expect(() => service.replaceBackground(backgroundParams, 'legacy')).toThrow(
      'chưa hỗ trợ',
    );
    expect(legacy.editImage).not.toHaveBeenCalled();
    expect(gemini.editImage).not.toHaveBeenCalled();
  });
  it.each([
    { buffer: Buffer.alloc(0), mimeType: 'image/png' },
    { buffer: Buffer.from('invalid'), mimeType: 'text/html' },
  ])('rejects invalid background output before storage: %s', async (result) => {
    const selected = {
      ...provider('selected', ['text', 'vision', 'image']),
      replaceBackground: jest.fn().mockResolvedValue(result),
    };
    const service = new AIService(new ConfigService({}), [gemini, selected]);
    await expect(
      service.replaceBackground(backgroundParams, 'selected'),
    ).rejects.toMatchObject({
      response: { code: 'AI_INVALID_RESPONSE' },
      retryable: false,
    });
  });
  let gemini: ReturnType<typeof provider>;
  let vyceai: ReturnType<typeof provider>;
  beforeEach(() => {
    gemini = provider('gemini', ['text', 'vision', 'image']);
    vyceai = provider('vyceai', ['text']);
  });

  it('keeps Gemini as default for all tasks', () => {
    const service = new AIService(new ConfigService({}), [gemini, vyceai]);
    service.onModuleInit();
    expect(gemini.validateConfiguration).toHaveBeenCalledTimes(3);
    expect(vyceai.validateConfiguration).not.toHaveBeenCalled();
  });

  it('keeps concurrent request overrides independent from system defaults', async () => {
    const custom = provider('custom', ['text', 'vision', 'image']);
    const service = new AIService(new ConfigService({}), [
      gemini,
      vyceai,
      custom,
    ]);
    gemini.generateJSON.mockResolvedValue(['default prompt']);
    vyceai.generateJSON.mockResolvedValue(['vyce prompt']);
    custom.generateJSON.mockResolvedValue(['custom prompt']);
    expect(
      await Promise.all([
        service.generateMockupPrompts(analysis, 1, 'vyceai'),
        service.generateMockupPrompts(analysis, 1, 'custom'),
        service.generateMockupPrompts(analysis, 1),
      ]),
    ).toEqual([['vyce prompt'], ['custom prompt'], ['default prompt']]);
    await service.editImage(
      { base64Image: '', mimeType: 'image/png', prompt: 'edit' },
      'custom',
    );
    expect(custom.editImage).toHaveBeenCalledTimes(1);
    expect(gemini.editImage).not.toHaveBeenCalled();
    expect(service.getProviders().defaults).toEqual({
      text: 'gemini',
      vision: 'gemini',
      image: 'gemini',
    });
  });

  it('reports unsupported capabilities and unavailable providers without leaking configuration errors', () => {
    const custom = provider('custom', ['text', 'vision', 'image']);
    custom.validateConfiguration.mockImplementation((capability?: unknown) => {
      if (capability === 'image')
        throw new Error('private image configuration');
    });
    const offline = provider('offline', ['text']);
    offline.validateConfiguration.mockImplementation(() => {
      throw new Error('private API key');
    });
    const configured = new AIService(new ConfigService({}), [
      gemini,
      vyceai,
      custom,
      offline,
    ]);
    const catalog = configured.getProviders();
    expect(catalog.providers).toContainEqual({
      id: 'vyceai',
      name: 'vyceai',
      available: true,
      capabilities: ['text'],
      routing: { text: 'vyceai', vision: null, image: null },
    });
    expect(
      catalog.providers.find((entry) => entry.id === 'custom'),
    ).toMatchObject({
      capabilities: ['text', 'vision'],
      routing: { image: null },
    });
    expect(JSON.stringify(catalog)).not.toContain('private');
    expect(() =>
      configured.editImage(
        { base64Image: '', mimeType: 'image/png', prompt: 'edit' },
        'vyceai',
      ),
    ).toThrow('chưa hỗ trợ');
    expect(() => configured.generateImage('image', 'custom')).toThrow(
      'chưa hỗ trợ',
    );
    expect(gemini.editImage).not.toHaveBeenCalled();
    expect(gemini.generateImage).not.toHaveBeenCalled();
    expect(() => configured.generateImage('image', 'offline')).toThrow(
      'chưa được cấu hình',
    );
    expect(() => configured.generateImage('image', 'unknown')).toThrow(
      'không hợp lệ',
    );
  });

  it('propagates selected provider execution errors without spending on a fallback', async () => {
    const service = new AIService(new ConfigService({}), [gemini, vyceai]);
    vyceai.generateJSON.mockRejectedValue(new Error('Upstream unavailable'));
    await expect(
      service.generateMockupPrompts(analysis, 1, 'vyceai'),
    ).rejects.toThrow('xử lý tác vụ thất bại');
    expect(gemini.generateJSON).not.toHaveBeenCalled();
  });

  it('routes text to VyceAI and product analysis and image editing to Gemini', async () => {
    const service = new AIService(
      new ConfigService({ AI_TEXT_PROVIDER: 'vyceai' }),
      [gemini, vyceai],
    );
    service.onModuleInit();
    jest.mocked(gemini.generateJSON).mockResolvedValue(analysis);
    jest.mocked(vyceai.generateJSON).mockResolvedValue(['Studio background']);
    const file = {
      buffer: Buffer.from('product'),
      mimetype: 'image/png',
    } as Express.Multer.File;
    expect(await service.analyzeProductFromImage(file)).toEqual(analysis);
    expect(gemini.generateJSON).toHaveBeenCalledWith(expect.any(String), {
      base64: file.buffer.toString('base64'),
      mimeType: 'image/png',
    });
    expect(await service.generateMockupPrompts(analysis, 1)).toEqual([
      'Studio background',
    ]);
    expect(vyceai.generateJSON).toHaveBeenCalledWith(
      expect.stringContaining('Generate exactly 1'),
    );
    const params = {
      base64Image: 'aW1hZ2U=',
      mimeType: 'image/png',
      prompt: 'Edit background',
    };
    await service.editImage(params);
    expect(gemini.editImage).toHaveBeenCalledWith(params);
    expect(vyceai.editImage).not.toHaveBeenCalled();
    await service.generateImage('Studio photo');
    expect(gemini.generateImage).toHaveBeenCalledWith('Studio photo');
    const references = {
      productImageBase64: 'aW1hZ2U=',
      productMimeType: 'image/png',
      variations: 2,
    };
    await service.generateImagesFromReferalImages(references);
    expect(gemini.generateImagesFromReferalImages).toHaveBeenCalledWith(
      references,
    );
  });

  it('supports a third registered provider and task overrides of the common provider', async () => {
    const custom = provider('custom', ['text', 'vision', 'image']);
    jest
      .mocked(custom.generateJSON)
      .mockResolvedValue([
        { title: 'Idea', description: 'Details', prompt: 'Edit image' },
      ]);
    const service = new AIService(
      new ConfigService({ AI_PROVIDER: 'custom', AI_IMAGE_PROVIDER: 'gemini' }),
      [gemini, custom],
    );
    service.onModuleInit();
    await service.generateIdeasFromAttributes('Make a summer scene');
    expect(custom.generateJSON).toHaveBeenCalledWith(
      expect.stringContaining('Make a summer scene'),
    );
    expect(custom.validateConfiguration).toHaveBeenCalledWith('text');
    expect(custom.validateConfiguration).toHaveBeenCalledWith('vision');
    expect(gemini.validateConfiguration).toHaveBeenCalledWith('image');
  });

  it.each(['image', 'vision'])(
    'rejects unsupported VyceAI %s at startup',
    (capability) => {
      const service = new AIService(
        new ConfigService({
          [`AI_${capability.toUpperCase()}_PROVIDER`]: 'vyceai',
        }),
        [gemini, vyceai],
      );
      expect(() => service.onModuleInit()).toThrow(
        `does not support ${capability}`,
      );
    },
  );

  it('rejects unknown provider IDs and duplicate registry entries', () => {
    const service = new AIService(
      new ConfigService({ AI_TEXT_PROVIDER: 'typo' }),
      [gemini],
    );
    expect(() => service.onModuleInit()).toThrow('Unknown AI provider "typo"');
    expect(
      () => new AIService(new ConfigService({}), [gemini, gemini]),
    ).toThrow('Duplicate AI provider');
  });

  it('propagates configuration and upstream errors without silently falling back', async () => {
    const service = new AIService(
      new ConfigService({ AI_TEXT_PROVIDER: 'vyceai' }),
      [gemini, vyceai],
    );
    jest.mocked(vyceai.validateConfiguration).mockImplementation(() => {
      throw new Error('Missing key');
    });
    expect(() => service.onModuleInit()).toThrow('Missing key');
    jest
      .mocked(vyceai.generateJSON)
      .mockRejectedValue(new Error('Upstream unavailable'));
    await expect(service.generateMockupPrompts(analysis, 1)).rejects.toThrow(
      'xử lý tác vụ thất bại',
    );
    expect(gemini.generateJSON).not.toHaveBeenCalled();
  });

  it.each([
    { result: ['too few'] },
    { result: ['valid', ''] },
    { result: { prompts: ['one', 'two'] } },
  ])('rejects invalid mockup output $result', async ({ result }) => {
    const service = new AIService(new ConfigService({}), [gemini]);
    jest.mocked(gemini.generateJSON).mockResolvedValue(result);
    await expect(service.generateMockupPrompts(analysis, 2)).rejects.toThrow(
      'không trả về kết quả hợp lệ',
    );
  });

  it('rejects malformed analysis and idea output before image generation', async () => {
    const service = new AIService(new ConfigService({}), [gemini]);
    jest
      .mocked(gemini.generateJSON)
      .mockResolvedValue({ productType: 'shirt' });
    await expect(
      service.analyzeProductFromImage({
        buffer: Buffer.from('product'),
        mimetype: 'image/png',
      } as Express.Multer.File),
    ).rejects.toThrow('không trả về kết quả hợp lệ');
    jest
      .mocked(gemini.generateJSON)
      .mockResolvedValue([
        { title: 'Idea', description: 'Details', prompt: '' },
      ]);
    await expect(service.generateIdeasFromAttributes('Summer')).rejects.toThrow(
      'không trả về kết quả hợp lệ',
    );
    expect(gemini.editImage).not.toHaveBeenCalled();
  });

  it('rejects an image provider that declares support but omits operations', () => {
    delete gemini.editImage;
    const service = new AIService(new ConfigService({}), [gemini]);
    expect(() => service.onModuleInit()).toThrow('missing image operations');
  });
  it('rejects an incorrect idea count', async () => {
    const service = new AIService(new ConfigService({}), [gemini]);
    gemini.generateJSON.mockResolvedValue([
      { title: 'one', description: '', prompt: 'edit' },
    ]);
    await expect(
      service.generateIdeasFromAttributes('prompt', 2),
    ).rejects.toThrow('không trả về kết quả hợp lệ');
  });
  it('rejects malformed optional analysis metadata', async () => {
    const service = new AIService(new ConfigService({}), [gemini]);
    gemini.generateJSON.mockResolvedValue({
      ...analysis,
      characters: { hasCharacters: true, characterNames: 'wrong type' },
    });
    await expect(
      service.analyzeProductFromImage({
        buffer: Buffer.from('product'),
        mimetype: 'image/png',
      } as Express.Multer.File),
    ).rejects.toThrow('không trả về kết quả hợp lệ');
  });
});
