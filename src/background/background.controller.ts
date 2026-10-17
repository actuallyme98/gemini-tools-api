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
import {
  providerSelectionSchema,
  imageModelSelectionSchema,
} from '../ai/provider-selection.dto';
import { BackgroundService } from './background.service';
import {
  MAX_BACKGROUND_PROMPT_LENGTH,
  ReplaceBackgroundDto,
} from './dto/replace-background.dto';

@Controller('backgrounds')
export class BackgroundController {
  constructor(private readonly backgrounds: BackgroundService) {}

  @Post('replace')
  @ApiOperation({
    summary:
      'Edit a reference photo using the source product and the complete user-edited prompt. One request produces one edited photo; no hidden prompt rules are appended.',
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
        requestId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['productImage', 'backgroundImage', 'instructions'],
      properties: {
        productImage: {
          type: 'string',
          format: 'binary',
          description: 'Source product showing the exact artwork to transfer.',
        },
        backgroundImage: {
          type: 'string',
          format: 'binary',
          description:
            'Reference photo to edit, supplied as IMAGE 2 after the source product.',
        },
        provider: providerSelectionSchema,
        imageModel: imageModelSelectionSchema,
        instructions: {
          type: 'string',
          maxLength: MAX_BACKGROUND_PROMPT_LENGTH,
          description: 'Final prompt edited by the user, forwarded verbatim.',
        },
        variationIndex: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
      },
    },
  })
  async replace(
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
    const result = await this.backgrounds.replace({
      productImage: requireImage(files?.productImage?.[0], 'Product image'),
      backgroundImage: requireImage(
        files?.backgroundImage?.[0],
        'Reference image',
      ),
      instructions: body.instructions,
      variationIndex: body.variationIndex,
      provider: body.provider,
      imageModel: body.imageModel,
      signal: requestSignal(response),
    });
    const requestId = response.getHeader('X-Request-Id');
    return {
      ...result,
      ...(requestId ? { requestId: String(requestId) } : {}),
    };
  }
}
