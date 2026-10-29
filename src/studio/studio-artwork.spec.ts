import sharp from 'sharp';
import { prepareArtwork } from './studio-artwork';
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
