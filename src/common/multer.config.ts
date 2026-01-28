import { MulterModuleOptions } from '@nestjs/platform-express';

export const multerConfig: MulterModuleOptions = {
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
};
