import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  IsIn,
} from 'class-validator';

export const providerSelectionSchema = {
  type: 'string' as const,
  maxLength: 64,
  pattern: '^[a-z0-9][a-z0-9_-]*$',
  example: 'shopaikey',
  description:
    'Optional provider ID from GET /api/ai/providers. Image/vision steps use this provider; text uses automatic routing when enabled. Unsupported or unconfigured tasks return HTTP 400. Omit for system defaults.',
};

export const imageModelSelectionSchema = {
  type: 'string' as const,
  maxLength: 128,
  pattern: '^[a-z0-9][a-z0-9._-]*$',
  description:
    'Optional image model ID from GET /api/ai/providers/{provider}/image-models. Applies only to image generation/editing. Omit for the configured image model.',
};

export class ProviderSelectionDto {
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  async?: string;
  @ApiPropertyOptional(providerSelectionSchema)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9_-]*$/)
  provider?: string;
}

export class ImageProviderSelectionDto extends ProviderSelectionDto {
  @ApiPropertyOptional(imageModelSelectionSchema)
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-z0-9][a-z0-9._-]*$/)
  imageModel?: string;
}
