import sharp from 'sharp';
import { Worker } from 'node:worker_threads';
import type { MockupTemplate, Point } from './agent.types';
import { ApiError } from '../common/api-error';

export function validateCorners(points: Point[]) {
  if (
    points.length !== 4 ||
    points.some(
      (p) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.y < 0 ||
        p.x > 1 ||
        p.y > 1,
    )
  )
    throw new ApiError(
      400,
      'TEMPLATE_CORNERS',
      'Vùng in phải có 4 góc trong ảnh, theo thứ tự trên trái, trên phải, dưới phải, dưới trái.',
    );
  for (let i = 0; i < 4; i++) {
    const a = points[i],
      b = points[(i + 1) % 4],
      c = points[(i + 2) % 4];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < 0.0001)
      throw new ApiError(
        400,
        'TEMPLATE_CORNERS',
        'Vùng in phải là tứ giác lồi, không giao nhau và có diện tích đủ lớn.',
      );
  }
}

// This function is self-contained so the pixel loop can run off the API thread.
export function perspective(
  input: Uint8Array,
  sw: number,
  sh: number,
  width: number,
  height: number,
  corners: Point[],
  opacity: number,
) {
  const matrix: number[][] = [];
  const uv = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  corners.forEach((p, i) => {
    const x = p.x * (width - 1),
      y = p.y * (height - 1),
      [u, v] = uv[i];
    matrix.push(
      [x, y, 1, 0, 0, 0, -u * x, -u * y, u],
      [0, 0, 0, x, y, 1, -v * x, -v * y, v],
    );
  });
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++)
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col]))
        pivot = row;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col];
    if (Math.abs(divisor) < 1e-10)
      throw new Error('Invalid print-area transform');
    for (let j = col; j < 9; j++) matrix[col][j] /= divisor;
    for (let row = 0; row < 8; row++)
      if (row !== col) {
        const factor = matrix[row][col];
        for (let j = col; j < 9; j++) matrix[row][j] -= factor * matrix[col][j];
      }
  }
  const h = matrix.map((row) => row[8]);
  const result = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const denom = h[6] * x + h[7] * y + 1;
      const u = (h[0] * x + h[1] * y + h[2]) / denom;
      const v = (h[3] * x + h[4] * y + h[5]) / denom;
      if (u < -1e-8 || v < -1e-8 || u > 1.00000001 || v > 1.00000001) continue;
      const sx = Math.max(0, Math.min(sw - 1, u * (sw - 1))),
        sy = Math.max(0, Math.min(sh - 1, v * (sh - 1)));
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        dx = sx - x0,
        dy = sy - y0;
      const samples = [
        [x0, y0, (1 - dx) * (1 - dy)],
        [Math.min(x0 + 1, sw - 1), y0, dx * (1 - dy)],
        [x0, Math.min(y0 + 1, sh - 1), (1 - dx) * dy],
        [Math.min(x0 + 1, sw - 1), Math.min(y0 + 1, sh - 1), dx * dy],
      ];
      let alpha = 0;
      const rgb = [0, 0, 0];
      for (const [px, py, weight] of samples) {
        const index = (py * sw + px) * 4,
          a = (input[index + 3] / 255) * weight;
        alpha += a;
        for (let c = 0; c < 3; c++) rgb[c] += input[index + c] * a;
      }
      const offset = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        result[offset + c] = alpha ? rgb[c] / alpha : 0;
      result[offset + 3] = alpha * opacity * 255;
    }
  return result;
}

export async function renderTemplate(
  base: Buffer,
  design: Buffer,
  template: MockupTemplate,
  mask?: Buffer,
  overlay?: Buffer,
) {
  validateCorners(template.corners);
  const canvas = await sharp(base, { limitInputPixels: 4_000_000 })
    .rotate()
    .ensureAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  const width = canvas.info.width,
    height = canvas.info.height;
  const p = template.corners;
  const distance = (a: Point, b: Point) =>
    Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const sw = Math.max(
    2,
    Math.round((distance(p[0], p[1]) + distance(p[3], p[2])) / 2),
  );
  const sh = Math.max(
    2,
    Math.round((distance(p[0], p[3]) + distance(p[1], p[2])) / 2),
  );
  const source = await sharp(design, { limitInputPixels: 32_000_000 })
    .rotate()
    .resize(sw, sh, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const warped = await new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(
      `const {parentPort,workerData:d}=require('node:worker_threads'); const render=${perspective.toString()}; parentPort.postMessage(render(d.source,d.sw,d.sh,d.width,d.height,d.corners,d.opacity));`,
      {
        eval: true,
        workerData: {
          source,
          sw,
          sh,
          width,
          height,
          corners: p,
          opacity: template.opacity,
        },
      },
    );
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error('Template worker stopped'));
    });
  });
  let layer = await sharp(Buffer.from(warped), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
  if (mask) {
    const alpha = await sharp(mask, { limitInputPixels: 4_000_000 })
      .rotate()
      .resize(width, height, { fit: 'fill' })
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer();
    const rgba = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i];
    layer = await sharp(layer)
      .composite([
        { input: rgba, raw: { width, height, channels: 4 }, blend: 'dest-in' },
      ])
      .png()
      .toBuffer();
  }
  const composites: sharp.OverlayOptions[] = [
    { input: layer, blend: template.blend },
  ];
  if (overlay)
    composites.push({
      input: await sharp(overlay, { limitInputPixels: 4_000_000 })
        .rotate()
        .resize(width, height, { fit: 'fill' })
        .png()
        .toBuffer(),
      blend: 'over',
    });
  return sharp(canvas.data).composite(composites).png().toBuffer();
}
