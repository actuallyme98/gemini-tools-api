import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Min, Max } from 'class-validator';

export class GeneratePromptsDto {
  @ApiProperty({ example: 6 })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return parseInt(value);
    } else {
      return value;
    }
  })
  @IsInt()
  @Min(1)
  @Max(12)
  count: number;
}
