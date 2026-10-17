import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ImageProviderSelectionDto } from '../../ai/provider-selection.dto';

export const MAX_BACKGROUND_PROMPT_LENGTH = 12000;

export class ReplaceBackgroundDto extends ImageProviderSelectionDto {
  @ApiProperty({
    maxLength: MAX_BACKGROUND_PROMPT_LENGTH,
    description:
      'Complete user-edited prompt. Forwarded verbatim with the source product first and the reference photo second; no hidden base or variation instructions are appended.',
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
