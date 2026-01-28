import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
  BadRequestException,
  UploadedFiles,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';

import { IdeaService } from './idea.service';
import { GenerateIdeaDTO } from './dto/create-idea.dto';

@Controller('ideas')
export class IdeaController {
  constructor(private readonly ideaService: IdeaService) {}

  @Post('analyze-product')
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
      },
      required: ['image'],
    },
  })
  async analyzeProductController(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Image is required');
    }

    return this.ideaService.analyzeProductFromImage(file);
  }

  @Post('generate-ideas')
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
  ) {
    return this.ideaService.generateIdeasFromImage(file, body.basePrompt);
  }

  @Post('generate-images-from-referal-images')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'productImage', maxCount: 1 },
      { name: 'referenceImages', maxCount: 10 },
    ]),
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
          type: 'number',
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
    @Body('variations') variations?: number,
  ) {
    if (!files.productImage?.[0]) {
      throw new BadRequestException('productImage is required');
    }

    return this.ideaService.generateIdeasFromReferalImages({
      productImage: files.productImage[0],
      referenceImages: files.referenceImages,
      variations: variations ? Number(variations) : undefined,
    });
  }
}
