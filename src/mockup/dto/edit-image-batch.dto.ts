import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsString,
  ArrayNotEmpty,
  ArrayMaxSize,
  MinLength,
  MaxLength,
} from 'class-validator';
export class EditImageBatchDto {
  @ApiProperty({
    description: 'JSON array of 1–20 non-empty prompts',
    example: '["Add a studio background"]',
  })
  @Transform(({ value }: { value: unknown }) => {
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return Array.isArray(parsed)
      ? parsed.map((item: unknown) =>
          typeof item === 'string' ? item.trim() : item,
        )
      : parsed;
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(4000, { each: true })
  prompts: string[];
}
