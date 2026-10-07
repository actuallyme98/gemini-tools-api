import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const providerSelectionSchema = {
  type: 'string' as const,
  maxLength: 64,
  pattern: '^[a-z0-9][a-z0-9_-]*$',
  example: 'shopaikey',
  description:
    'Optional provider ID from GET /api/ai/providers. Unsupported or unconfigured capabilities use system defaults. Omit for system defaults.',
};

export class ProviderSelectionDto {
  @ApiPropertyOptional(providerSelectionSchema)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9_-]*$/)
  provider?: string;
}
