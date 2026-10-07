import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ProviderSelectionDto } from '../../ai/provider-selection.dto';

export class ReplaceBackgroundDto extends ProviderSelectionDto {
  @ApiPropertyOptional({
    maxLength: 2000,
    description:
      'Optional lighting or placement preferences; product identity is always preserved.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(2000)
  instructions?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 3, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  variationIndex = 1;
}
