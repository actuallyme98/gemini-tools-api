import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AIModule } from './ai.module';
import { AIService } from './ai.service';
import { VyceAIProvider } from './providers/vyceai.provider';
import { ShopAIKeyProvider } from './providers/shopaikey.provider';
import { GeminiService } from '../gemini/gemini.service';
import { MockupModule } from '../mockup/mockup.module';
import { MockupService } from '../mockup/mockup.service';
import { IdeaModule } from '../idea/idea.module';
import { IdeaService } from '../idea/idea.service';
import { R2Service } from '../r2/r2.service';

describe('AI module integration', () => {
  it('registers ShopAIKey for all tasks without requiring Gemini or VyceAI credentials', async () => {
    const shopaikey = {
      id: 'shopaikey',
      capabilities: ['text', 'vision', 'image'],
      validateConfiguration: jest.fn(),
      generateJSON: jest.fn().mockResolvedValue(['Studio']),
      generateImage: jest.fn().mockResolvedValue(Buffer.from('generated')),
      editImage: jest.fn().mockResolvedValue(Buffer.from('edited')),
      generateImagesFromReferalImages: jest
        .fn()
        .mockResolvedValue([Buffer.from('reference')]),
    };
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: [() => ({ AI_PROVIDER: 'shopaikey' })],
        }),
        AIModule,
      ],
    })
      .overrideProvider(ShopAIKeyProvider)
      .useValue(shopaikey)
      .compile();
    try {
      await module.init();
      const ai = module.get(AIService);
      expect(shopaikey.validateConfiguration.mock.calls).toEqual([
        ['text'],
        ['vision'],
        ['image'],
      ]);
      expect(await ai.generateImage('Product')).toEqual(
        Buffer.from('generated'),
      );
      const params = {
        base64Image: 'aW1hZ2U=',
        mimeType: 'image/png',
        prompt: 'New background',
      };
      expect(await ai.editImage(params)).toEqual(Buffer.from('edited'));
      expect(shopaikey.editImage).toHaveBeenCalledWith(params);
      expect(
        await ai.generateImagesFromReferalImages({
          productImageBase64: 'aW1hZ2U=',
          productMimeType: 'image/png',
        }),
      ).toEqual([Buffer.from('reference')]);
    } finally {
      await module.close();
    }
  });

  it('shares providers between business modules and preserves image results', async () => {
    const image = Buffer.from('edited');
    const gemini = {
      id: 'gemini',
      capabilities: ['text', 'vision', 'image'],
      validateConfiguration: jest.fn(),
      generateJSON: jest.fn(),
      generateImage: jest.fn(),
      editImage: jest.fn().mockResolvedValue(image),
      generateImagesFromReferalImages: jest.fn().mockResolvedValue([image]),
    };
    const vyceai = {
      id: 'vyceai',
      capabilities: ['text'],
      validateConfiguration: jest.fn(),
      generateJSON: jest
        .fn()
        .mockResolvedValue([
          { title: 'Studio', description: 'Clean', prompt: 'White background' },
        ]),
    };
    const upload = jest
      .fn()
      .mockResolvedValue('https://cdn.example/mockups/test.png');
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: [() => ({ AI_TEXT_PROVIDER: 'vyceai' })],
        }),
        MockupModule,
        IdeaModule,
      ],
    })
      .overrideProvider(GeminiService)
      .useValue(gemini)
      .overrideProvider(VyceAIProvider)
      .useValue(vyceai)
      .overrideProvider(R2Service)
      .useValue({ upload })
      .compile();

    try {
      await module.init();
      const ai = module.get(AIService);
      expect(module.select(AIModule).get(AIService, { strict: true })).toBe(ai);
      const file = {
        buffer: Buffer.from('product'),
        mimetype: 'image/png',
      } as Express.Multer.File;
      expect(
        await module
          .get(MockupService)
          .generateMockups(file, ['White background']),
      ).toEqual({
        total: 1,
        results: [
          {
            index: 0,
            prompt: 'White background',
            url: 'https://cdn.example/mockups/test.png',
          },
        ],
      });
      expect(
        await module.get(IdeaService).generateIdeasFromImage(file, 'Studio', 1),
      ).toEqual([
        {
          prompt: 'White background',
          url: 'https://cdn.example/mockups/test.png',
        },
      ]);
      expect(
        await module
          .get(IdeaService)
          .generateIdeasFromReferalImages({ productImage: file }),
      ).toEqual(['https://cdn.example/mockups/test.png']);
      expect(upload).toHaveBeenCalledTimes(3);
      expect(gemini.editImage).toHaveBeenCalledTimes(2);
      expect(vyceai.generateJSON).toHaveBeenCalledTimes(1);
    } finally {
      await module.close();
    }
  });
});
