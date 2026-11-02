import sharp from 'sharp';
import {
  artworkPrompt,
  thumbnailPrompt,
  prepareArtwork,
} from './studio-artwork';
import type { StudioSnapshot } from './studio.types';
import { preserveReferenceScene } from './studio-mockup-prompt';
describe('Studio artwork file constraints', () => {
  it('exports the configured dimensions/DPI but does not label opaque output as transparent', async () => {
    const input = await sharp({
      create: { width: 80, height: 40, channels: 3, background: '#e38028' },
    })
      .png()
      .toBuffer();
    const output = await prepareArtwork(input, {
      width: 256,
      height: 128,
      dpi: 300,
      background: 'white',
    });
    expect(await sharp(output.buffer).metadata()).toMatchObject({
      width: 256,
      height: 128,
      density: 300,
      format: 'png',
    });
    expect(output.checks.technical).toBe(true);
    expect(output.checks.visual).toBe('not_checked');
    expect(
      (
        await prepareArtwork(input, {
          width: 256,
          height: 128,
          dpi: 300,
          background: 'transparent',
        })
      ).checks.technical,
    ).toBe(false);
    expect((await prepareArtwork(input)).checks.technical).toBe(false);
  });
});

it('keeps physical product context out of the artwork instructions and preserves the thumbnail target style', () => {
  const snapshot: StudioSnapshot = {
    input: {
      title: 'Botanical print',
      storeId: 'store',
      productId: 'product',
      skillId: 'skill',
      thumbnailId: 'master',
      sourceId: 'source',
      sourceUrl: '',
      brief: 'Keep HELLO and the leaf motif',
      count: 1,
      timing: 'now',
      provider: 'shopaikey',
      imageModel: 'test-image',
      artworkFirst: true,
    },
    product: {
      id: 'product',
      code: 'P01',
      name: 'Mat',
      instructions: 'Woven mat with stitched edge',
      printSpec: { width: 1024, height: 512, dpi: 300, background: 'white' },
    },
    skill: {
      id: 'skill',
      code: 'SK01',
      name: 'Botanical',
      instructions: 'Preserve HELLO',
      documents: [],
    },
    thumbnail: {
      id: 'master',
      code: 'M01',
      name: 'Vector scene',
      instructions: 'Keep the door and plant',
    },
    source: { id: 'source', owner: 'seller', sha256: 'source-hash' },
    master: { id: 'master', owner: 'admin', sha256: 'master-hash' },
    hash: 'snapshot-hash',
  };
  const prompt = artworkPrompt(snapshot, {
    title: 'Leaf frame',
    direction: 'Botanical',
    composition: 'Frame',
    palette: 'Green',
    prompt: 'Print HELLO with a leaf frame',
  });
  expect(prompt).toContain(snapshot.input.brief);
  expect(prompt).toContain('chỉ là ngữ cảnh cho bước thumbnail');
  expect(prompt).toContain('không phải hình một sản phẩm đặt trên nền trắng');
  expect(prompt).toContain('Không vẽ silhouette/vỏ sản phẩm');
  expect(thumbnailPrompt(snapshot)).toContain(preserveReferenceScene);
  expect(thumbnailPrompt(snapshot)).toContain('ARTWORK GỐC');
});
