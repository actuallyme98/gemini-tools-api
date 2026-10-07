import {
  Body,
  Controller,
  Post,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { multerConfig, requireImage } from '../common/multer.config';
import { requestSignal } from '../common/request-signal';
import { providerSelectionSchema } from '../ai/provider-selection.dto';
import { BackgroundService } from './background.service';
import { ReplaceBackgroundDto } from './dto/replace-background.dto';

@Controller('backgrounds')
export class BackgroundController {
  constructor(private readonly backgrounds: BackgroundService) {}

  @Post('replace')
  @ApiOperation({
    summary:
      'Replace a product background using one background reference image. One request produces one result; clients can queue multiple pairs.',
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'productImage', maxCount: 1 },
        { name: 'backgroundImage', maxCount: 1 },
      ],
      {
        ...multerConfig,
        limits: { ...multerConfig.limits, files: 2, fields: 5 },
      },
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      required: ['url', 'mimeType'],
      properties: {
        url: { type: 'string', format: 'uri' },
        mimeType: {
          type: 'string',
          enum: ['image/png', 'image/jpeg', 'image/webp'],
        },
      },
    },
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['productImage', 'backgroundImage'],
      properties: {
        productImage: { type: 'string', format: 'binary' },
        backgroundImage: { type: 'string', format: 'binary' },
        provider: providerSelectionSchema,
        instructions: { type: 'string', maxLength: 2000 },
        variationIndex: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
      },
    },
  })
  replace(
    @UploadedFiles()
    files:
      | {
          productImage?: Express.Multer.File[];
          backgroundImage?: Express.Multer.File[];
        }
      | undefined,
    @Body() body: ReplaceBackgroundDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.backgrounds.replace({
      productImage: requireImage(files?.productImage?.[0], 'Product image'),
      backgroundImage: requireImage(
        files?.backgroundImage?.[0],
        'Background image',
      ),
      instructions: body.instructions,
      variationIndex: body.variationIndex,
      provider: body.provider,
      signal: requestSignal(response),
    });
  }
}
