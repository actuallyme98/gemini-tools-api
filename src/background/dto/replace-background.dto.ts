import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ImageProviderSelectionDto } from '../../ai/provider-selection.dto';

export const MAX_BACKGROUND_PROMPT_LENGTH = 12000;

export class ReplaceBackgroundDto extends ImageProviderSelectionDto {
  @ApiPropertyOptional({
    type: String,
    enum: ['true', 'false'],
    description: 'Return a short-lived job immediately and poll its result.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  async?: string;

  @ApiProperty({
    maxLength: MAX_BACKGROUND_PROMPT_LENGTH,
    description:
      'Final prompt, forwarded verbatim with the reference photo (edit target) first and source product second.',
  })
  @IsString()
  @Matches(/\S/, {
    message: 'instructions must contain a non-whitespace prompt',
  })
  @MaxLength(MAX_BACKGROUND_PROMPT_LENGTH)
  instructions: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 3, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  variationIndex = 1;
}
