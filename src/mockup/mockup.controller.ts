import {
  providerSelectionSchema,
  imageModelSelectionSchema,
} from '../ai/provider-selection.dto';
import type { Response } from 'express';
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
  Req,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiAcceptedResponse } from '@nestjs/swagger';

import { GeneratePromptsDto } from './dto/create-mockup.dto';
import { EditImageBatchDto } from './dto/edit-image-batch.dto';
import { storeImage } from '../common/image-task';
import { AgentGuard, type AgentRequest } from '../agent/agent-auth.service';

@Controller('mockups')
@UseGuards(AgentGuard)
export class MockupController {
  constructor(private readonly jobs: ImageJobsService) {}

  @Get('jobs/:jobId')
  @Header('Cache-Control', 'no-store')
  getJob(
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Req() req: AgentRequest,
  ) {
    return this.jobs.get(jobId, req.agentUser.id);
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
    @Req() req: AgentRequest,
  ) {
    return this.jobs.respond(
      {
        operation: 'prompts',
        images: [storeImage(requireImage(file))],
        count: body.count,
        provider: body.provider,
      },
      req,
      response,
      body.async === 'true',
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
    @Req() req: AgentRequest,
  ) {
    const image = requireImage(file);
    if (dto.async === 'true') {
      if (dto.prompts.length !== 1)
        throw new ApiError(
          400,
          'MOCKUP_SINGLE_PROMPT_REQUIRED',
          'Mỗi tác vụ chỉ nhận một prompt. Gửi từng ảnh riêng để giữ kết quả đã hoàn tất.',
        );
      return this.jobs.respond(
        {
          operation: 'mockup',
          images: [storeImage(image)],
          prompt: dto.prompts[0],
          provider: dto.provider,
          imageModel: dto.imageModel,
        },
        req,
        response,
        true,
      );
    }
    return this.jobs.respond(
      {
        operation: 'mockup-batch',
        images: [storeImage(image)],
        prompts: dto.prompts,
        provider: dto.provider,
        imageModel: dto.imageModel,
      },
      req,
      response,
    );
  }
}
