import {
  ProviderSelectionDto,
  providerSelectionSchema,
  imageModelSelectionSchema,
} from '../ai/provider-selection.dto';
import type { Response } from 'express';
import { multerConfig, requireImage } from '../common/multer.config';
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
  Res,
  UploadedFiles,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';

import { GenerateIdeaDTO, ReferenceImagesDTO } from './dto/create-idea.dto';
import { ImageJobsService } from '../common/image-jobs.service';
import { storeImage } from '../common/image-task';
import { AgentGuard, type AgentRequest } from '../agent/agent-auth.service';

@Controller('ideas')
@UseGuards(AgentGuard)
export class IdeaController {
  constructor(private readonly jobs: ImageJobsService) {}

  @Post('analyze-product')
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
      },
      required: ['image'],
    },
  })
  async analyzeProductController(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: ProviderSelectionDto,
    @Res({ passthrough: true }) response: Response,
    @Req() req: AgentRequest,
  ) {
    return this.jobs.respond(
      {
        operation: 'analyze',
        images: [storeImage(requireImage(file))],
        provider: body.provider,
      },
      req,
      response,
      body.async === 'true',
    );
  }

  @Post('generate-ideas')
  @UseInterceptors(FileInterceptor('image', multerConfig))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        imageModel: imageModelSelectionSchema,
        provider: providerSelectionSchema,
        image: {
          type: 'string',
          format: 'binary',
        },
        count: { type: 'integer', minimum: 1, maximum: 12, default: 3 },
        basePrompt: {
          type: 'string',
          example: '',
        },
      },
      required: ['image', 'basePrompt'],
    },
  })
  async generateIdeasController(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: GenerateIdeaDTO,
    @Res({ passthrough: true }) response: Response,
    @Req() req: AgentRequest,
  ) {
    return this.jobs.respond(
      {
        operation: 'ideas',
        images: [storeImage(requireImage(file))],
        prompt: body.basePrompt,
        count: body.count,
        provider: body.provider,
        imageModel: body.imageModel,
      },
      req,
      response,
      body.async === 'true',
    );
  }

  @Post('generate-images-from-referal-images')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'productImage', maxCount: 1 },
        { name: 'referenceImages', maxCount: 10 },
      ],
      multerConfig,
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        imageModel: imageModelSelectionSchema,
        provider: providerSelectionSchema,
        productImage: {
          type: 'string',
          format: 'binary',
          description: 'Main product image (source of truth)',
        },
        referenceImages: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
          description: 'Reference images for style and idea inspiration',
        },
        variations: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          default: 1,
          example: 3,
          description: 'Number of idea images to generate (default: 1)',
        },
      },
      required: ['productImage'],
    },
  })
  async generateImagesFromReferalImagesController(
    @UploadedFiles()
    files: {
      productImage?: Express.Multer.File[];
      referenceImages?: Express.Multer.File[];
    },
    @Body() body: ReferenceImagesDTO,
    @Res({ passthrough: true }) response: Response,
    @Req() req: AgentRequest,
  ) {
    return this.jobs.respond(
      {
        operation: 'references',
        images: [
          requireImage(files.productImage?.[0]),
          ...(files.referenceImages ?? []).map((file) => requireImage(file)),
        ].map(storeImage),
        count: body.variations,
        provider: body.provider,
        imageModel: body.imageModel,
      },
      req,
      response,
      body.async === 'true',
    );
  }
}
