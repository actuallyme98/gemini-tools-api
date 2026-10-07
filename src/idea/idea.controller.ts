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
  UploadedFiles,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';

import { IdeaService } from './idea.service';
import { GenerateIdeaDTO, ReferenceImagesDTO } from './dto/create-idea.dto';

@Controller('ideas')
export class IdeaController {
  constructor(private readonly ideaService: IdeaService) {}

  @Post('analyze-product')
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
      },
      required: ['image'],
    },
  })
  async analyzeProductController(@UploadedFile() file: Express.Multer.File) {
    return this.ideaService.analyzeProductFromImage(requireImage(file));
  }

  @Post('generate-ideas')
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
  ) {
    return this.ideaService.generateIdeasFromImage(
      requireImage(file),
      body.basePrompt,
      body.count,
      requestSignal(response),
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
  ) {
    return this.ideaService.generateIdeasFromReferalImages({
      productImage: requireImage(files.productImage?.[0]),
      referenceImages: files.referenceImages?.map((file) => requireImage(file)),
      variations: body.variations,
      signal: requestSignal(response),
    });
  }
}
