import { ProviderSelectionDto } from '../../ai/provider-selection.dto';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min, Max } from 'class-validator';
export class GeneratePromptsDto extends ProviderSelectionDto {
  @ApiProperty({ example: 3, minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  count: number;
}
