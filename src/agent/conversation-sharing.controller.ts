import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import * as Joi from 'joi';
import type { Request, Response } from 'express';
import { AgentGuard, type AgentRequest } from './agent-auth.service';
import { AgentDatabaseFilter } from './agent-database.filter';
import { ConversationSharingService } from './conversation-sharing.service';
import { idSchema, parse } from './agent.schemas';
import { ApiError } from '../common/api-error';

@Controller('agent/conversations')
@UseGuards(AgentGuard)
@UseFilters(AgentDatabaseFilter)
export class ConversationSharingController {
  constructor(private readonly sharing: ConversationSharingService) {}

  @Get(':id/share')
  @Header('Cache-Control', 'private, no-store')
  async current(@Req() req: AgentRequest, @Param('id') id: string) {
    return {
      share: await this.sharing.current(
        req.agentUser.id,
        parse<string>(idSchema.required(), id),
      ),
    };
  }

  @Post(':id/share')
  @Header('Cache-Control', 'private, no-store')
  publish(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { includeImages } = parse<{ includeImages: boolean }>(
      Joi.object({ includeImages: Joi.boolean().strict().required() }),
      body,
    );
    return this.sharing.publish(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
      includeImages,
    );
  }

  @Delete(':id/share')
  @HttpCode(204)
  async revoke(@Req() req: AgentRequest, @Param('id') id: string) {
    await this.sharing.revoke(
      req.agentUser.id,
      parse<string>(idSchema.required(), id),
    );
  }
}

@Controller('agent/shared')
@UseFilters(AgentDatabaseFilter)
export class SharedConversationController {
  constructor(private readonly sharing: ConversationSharingService) {}

  private token(id: string, token = '') {
    if (token.slice(0, 36) !== parse<string>(idSchema.required(), id))
      throw new ApiError(
        404,
        'CONVERSATION_SHARE_UNAVAILABLE',
        'Link chia sẻ không tồn tại hoặc đã được thu hồi.',
      );
    return token;
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Header('Referrer-Policy', 'no-referrer')
  read(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('x-share-token') token: string,
    @Query('after') after?: string,
    @Query('version') version?: string,
  ) {
    const cursor =
      after === undefined
        ? 0
        : Number(
            parse<string>(
              Joi.string()
                .pattern(/^(0|[1-9]\d{0,3})$/)
                .required(),
              after,
            ),
          );
    return this.sharing.read(
      this.token(id, token),
      req.ip ?? 'unknown',
      parse<number>(Joi.number().integer().min(0).max(5000), cursor),
      version ? parse<string>(idSchema.required(), version) : undefined,
    );
  }

  @Get(':conversationId/assets/:id/preview')
  async preview(
    @Req() req: Request,
    @Res() res: Response,
    @Param('conversationId') conversationId: string,
    @Headers('x-share-token') token: string,
    @Param('id') id: string,
  ) {
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
    });
    const buffer = await this.sharing.preview(
      this.token(conversationId, token),
      req.ip ?? 'unknown',
      parse<string>(idSchema.required(), id),
    );
    res.type('image/webp').send(buffer);
  }
}
