import { IdeaService } from './idea.service';
import { AIService } from '../ai/ai.service';
import { R2Service } from '../r2/r2.service';
describe('Batch cancellation', () => {
  it('does not upload or schedule further variations after a disconnect', async () => {
    const controller = new AbortController();
    const generate = jest.fn(() => {
      controller.abort();
      return Promise.resolve([Buffer.from('image')]);
    });
    const upload = jest.fn();
    const service = new IdeaService(
      { generateImagesFromReferalImages: generate } as unknown as AIService,
      { upload } as unknown as R2Service,
    );
    await expect(
      service.generateIdeasFromReferalImages({
        productImage: {
          buffer: Buffer.from('product'),
          mimetype: 'image/png',
        } as Express.Multer.File,
        variations: 3,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  });
});
