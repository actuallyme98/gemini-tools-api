import type { Response } from 'express';
import { requestSignal } from '../common/request-signal';
import { multerConfig, requireImage } from '../common/multer.config';
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
  Res,
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
  @UseInterceptors(FileInterceptor('image', multerConfig))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          format: 'binary',
        },
        count: {
          type: 'number',
          example: '5',
        },
      },
      required: ['image', 'count'],
    },
  })
  async generatePrompts(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: GeneratePromptsDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.mockupService.generateMockupPrompts(
      requireImage(file),
      body.count,
      requestSignal(response),
    );
  }

  @Post('generate-mockups')
  @UseInterceptors(FileInterceptor('image', multerConfig))
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
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.mockupService.generateMockups(
      requireImage(file),
      dto.prompts,
      requestSignal(response),
    );
  }
}
