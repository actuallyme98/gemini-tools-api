import { ProviderSelectionDto } from '../../ai/provider-selection.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
export class GenerateIdeaDTO extends ProviderSelectionDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  basePrompt: string;
  @ApiPropertyOptional({ default: 3, minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  count = 3;
}
export class ReferenceImagesDTO extends ProviderSelectionDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  variations = 1;
}
