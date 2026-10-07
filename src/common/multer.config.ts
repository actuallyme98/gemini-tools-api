import { BadRequestException } from '@nestjs/common';
import type { MulterModuleOptions } from '@nestjs/platform-express';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const multerConfig: MulterModuleOptions = {
  limits: { fileSize: MAX_IMAGE_BYTES, files: 11, fields: 10 },
  fileFilter: (_request, file, callback) => {
    if (!IMAGE_MIME_TYPES.includes(file.mimetype)) {
      callback(
        new BadRequestException('Only PNG, JPEG and WebP images are supported'),
        false,
      );
      return;
    }
    callback(null, true);
  },
};
export function requireImage(file?: Express.Multer.File): Express.Multer.File {
  if (!file) throw new BadRequestException('Image is required');
  const b = file.buffer;
  const valid =
    (file.mimetype === 'image/png' &&
      b
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (file.mimetype === 'image/jpeg' &&
      b[0] === 255 &&
      b[1] === 216 &&
      b[2] === 255) ||
    (file.mimetype === 'image/webp' &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP');
  if (!valid)
    throw new BadRequestException(
      'Image content does not match its PNG, JPEG or WebP type',
    );
  return file;
}
