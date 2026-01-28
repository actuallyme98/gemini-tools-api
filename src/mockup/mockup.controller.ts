import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';

import { MockupService } from './mockup.service';
import { GeneratePromptsDto } from './dto/create-mockup.dto';
import { EditImageBatchDto } from './dto/edit-image-batch.dto';

@Controller('mockups')
export class MockupController {
  constructor(private readonly mockupService: MockupService) {}

  @Post('/generate-prompts')
  @UseInterceptors(FileInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          format: 'binary',
        },
        promptCount: {
          type: 'number',
          example: '5',
        },
      },
      required: ['image', 'promptCount'],
    },
  })
  async generatePrompts(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: GeneratePromptsDto,
  ) {
    return this.mockupService.generateMockupPrompts(file, body.count);
  }

  @Post('generate-mockups')
  @UseInterceptors(FileInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          format: 'binary',
        },
        prompts: {
          type: 'string',
          example: '["Add Christmas background","Change shirt color"]',
        },
      },
      required: ['image', 'prompts'],
    },
  })
  async editBatch(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: EditImageBatchDto,
  ) {
    if (!file) {
      throw new BadRequestException('Image is required');
    }

    return this.mockupService.generateMockups(file, dto.prompts);
  }
}
