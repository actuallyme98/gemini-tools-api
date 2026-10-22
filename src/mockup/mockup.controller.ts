import {
  providerSelectionSchema,
  imageModelSelectionSchema,
} from '../ai/provider-selection.dto';
import type { Response } from 'express';
import { requestSignal } from '../common/request-signal';
import { randomUUID } from 'node:crypto';
import { ImageJobsService } from '../common/image-jobs.service';
import { ApiError } from '../common/api-error';
import { multerConfig, requireImage } from '../common/multer.config';
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
  Res,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiAcceptedResponse } from '@nestjs/swagger';

import { MockupService } from './mockup.service';
import { GeneratePromptsDto } from './dto/create-mockup.dto';
import { EditImageBatchDto } from './dto/edit-image-batch.dto';

@Controller('mockups')
export class MockupController {
  constructor(
    private readonly mockupService: MockupService,
    private readonly jobs: ImageJobsService,
  ) {}

  @Get('jobs/:jobId')
  @Header('Cache-Control', 'no-store')
  getJob(@Param('jobId', new ParseUUIDPipe()) jobId: string) {
    return this.jobs.get(jobId);
  }

  @Post('/generate-prompts')
  @UseInterceptors(FileInterceptor('image', multerConfig))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        provider: providerSelectionSchema,
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
      body.provider,
    );
  }

  @Post('generate-mockups')
  @ApiAcceptedResponse({
    description:
      'async=true and one prompt: {jobId, requestId, state}; poll GET /api/mockups/jobs/:jobId.',
  })
  @UseInterceptors(FileInterceptor('image', multerConfig))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        async: { type: 'string', enum: ['true', 'false'] },
        imageModel: imageModelSelectionSchema,
        provider: providerSelectionSchema,
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
    const image = requireImage(file);
    if (dto.async === 'true') {
      if (dto.prompts.length !== 1)
        throw new ApiError(
          400,
          'MOCKUP_SINGLE_PROMPT_REQUIRED',
          'Mỗi tác vụ chỉ nhận một prompt. Gửi từng ảnh riêng để giữ kết quả đã hoàn tất.',
        );
      const requestId = String(
        response.getHeader('X-Request-Id') || randomUUID(),
      );
      const job = this.jobs.create(
        () =>
          this.mockupService.generateMockup(
            image,
            dto.prompts[0],
            undefined,
            dto.provider,
            dto.imageModel,
          ),
        requestId,
      );
      response.status(202);
      return job;
    }
    return this.mockupService.generateMockups(
      image,
      dto.prompts,
      requestSignal(response),
      dto.provider,
      dto.imageModel,
    );
  }
}
