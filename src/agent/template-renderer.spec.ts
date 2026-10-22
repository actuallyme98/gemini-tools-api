import sharp from 'sharp';
import {
  perspective,
  renderTemplate,
  validateCorners,
} from './template-renderer';
import type { MockupTemplate } from './agent.types';

const corners = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
];
describe('Template rendering', () => {
  it('rejects crossed or collapsed print areas', () => {
    expect(() =>
      validateCorners([corners[0], corners[2], corners[1], corners[3]]),
    ).toThrow();
    expect(() =>
      validateCorners(corners.map(() => ({ x: 0, y: 0 }))),
    ).toThrow();
    expect(() => validateCorners(corners)).not.toThrow();
  });
  it('maps artwork into the target quad and preserves transparent pixels and colors', () => {
    const design = Uint8Array.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const output = perspective(design, 2, 2, 5, 5, corners, 1);
    expect(
      Array.from(output.slice((1 * 5 + 1) * 4, (1 * 5 + 1) * 4 + 4)),
    ).toEqual([255, 0, 0, 255]);
    expect(
      Array.from(output.slice((1 * 5 + 3) * 4, (1 * 5 + 3) * 4 + 4)),
    ).toEqual([0, 255, 0, 255]);
    expect(output[3]).toBe(0);
  });
  it('composites on the template without altering background pixels', async () => {
    const base = await sharp({
      create: { width: 40, height: 40, channels: 4, background: '#0000ff' },
    })
      .png()
      .toBuffer();
    const design = await sharp({
      create: { width: 10, height: 10, channels: 4, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const result = await renderTemplate(base, design, {
      corners,
      opacity: 1,
      blend: 'over',
    } as MockupTemplate);
    const { data, info } = await sharp(result)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([40, 40]);
    expect(Array.from(data.subarray(0, 4))).toEqual([0, 0, 255, 255]);
    expect(
      Array.from(data.subarray((20 * 40 + 20) * 4, (20 * 40 + 20) * 4 + 4)),
    ).toEqual([255, 0, 0, 255]);
  });
});
