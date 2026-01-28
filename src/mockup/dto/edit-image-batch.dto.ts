import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsString, ArrayNotEmpty } from 'class-validator';

export class EditImageBatchDto {
  @ApiProperty({
    description: 'Array of prompts (JSON string)',
    example: ['Add Christmas background', 'Change shirt color'],
    type: [String],
  })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (e) {
        const prompts = value
          .split('.,')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s + '.');
        return prompts;
      }
    }
    return value;
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  prompts: string[];
}
