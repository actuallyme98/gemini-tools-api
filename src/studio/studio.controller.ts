import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as Joi from 'joi';
import sharp from 'sharp';
import { AgentGuard, type AgentRequest } from '../agent/agent-auth.service';
import { AgentDatabaseFilter } from '../agent/agent-database.filter';
import { idSchema, parse } from '../agent/agent.schemas';
import { adminAction } from '../agent/admin-audit';
import { ApiError } from '../common/api-error';
import { StudioService } from './studio.service';
import { StudioLibraryService } from './studio-library.service';
import type { IdeaInput, StudioTicket } from './studio.types';

const revision = Joi.number().integer().min(1).required();
const title = Joi.string().trim().min(1).max(160).required();
const identifier = (id: string) =>
  parse<string>(
    Joi.string()
      .pattern(/^[a-zA-Z0-9-]{1,150}$/)
      .required(),
    id,
  );
const ideaInput = Joi.object({
  artworkFirst: Joi.boolean(),
  title,
  storeId: idSchema.required(),
  productId: idSchema.allow('').required(),
  skillId: idSchema.allow('').required(),
  thumbnailId: idSchema.allow('').required(),
  sourceId: idSchema.allow('').required(),
  sourceUrl: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .max(2000)
    .allow('')
    .default(''),
  brief: Joi.string().trim().max(8000).allow('').required(),
  count: Joi.number().integer().min(1).max(12).required(),
  sampleCount: Joi.number().integer().min(1).max(12),
  timing: Joi.string().valid('now', 'night').required(),
  provider: Joi.string().valid('shopaikey', 'gemini').required(),
  imageModel: Joi.string().max(180).allow('').required(),
});
const teamInput = Joi.object({
  name: title,
  members: Joi.array()
    .items(
      Joi.object({
        userId: idSchema.required(),
        role: Joi.string().valid('leader', 'seller').required(),
      }),
    )
    .max(100)
    .required(),
  archived: Joi.boolean().default(false),
});
const storeInput = Joi.object({
  name: title,
  teamId: idSchema.required(),
  sellerIds: Joi.array().items(idSchema).unique().max(100).required(),
  productIds: Joi.array().items(idSchema).unique().max(100).required(),
  archived: Joi.boolean().default(false),
});
const pageNumber = (page?: string) =>
  parse<number>(
    Joi.number().integer().min(1).max(100000).required(),
    page === undefined ? 1 : Number(page),
  );

@Injectable()
export class StudioGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Cache-Control', 'no-store');
    if (!this.config.get<boolean>('STUDIO_ENABLED', false))
      throw new ApiError(
        503,
        'STUDIO_DISABLED',
        'Creative Studio chưa được bật. Dữ liệu và lịch sử cũ vẫn được giữ nguyên.',
      );
    return true;
  }
}
@Controller('agent/studio')
@UseFilters(AgentDatabaseFilter)
@UseGuards(AgentGuard, StudioGuard)
export class StudioController {
  constructor(
    private readonly studio: StudioService,
    private readonly library: StudioLibraryService,
    private readonly config: ConfigService,
  ) {}
  @Get('bootstrap') async bootstrap(@Req() req: AgentRequest) {
    return {
      ...(await this.studio.bootstrap(req.agentUser)),
      schedulerEnabled: this.config.get<boolean>(
        'STUDIO_SCHEDULER_ENABLED',
        false,
      ),
    };
  }
  @Get('dashboard') dashboard(@Req() req: AgentRequest) {
    return this.studio.dashboard(req.agentUser);
  }
  @Get('resources') catalog(
    @Req() req: AgentRequest,
    @Query() query: Record<string, unknown>,
  ) {
    return this.studio.catalog(
      req.agentUser,
      parse(
        Joi.object({
          teamId: idSchema.required(),
          type: Joi.string().valid('product', 'skill', 'thumbnail', 'scene'),
          q: Joi.string().trim().max(100).allow(''),
          status: Joi.string().valid('approved', 'pending', 'archived'),
          storeId: idSchema,
          page: Joi.number().integer().min(1).max(100000).default(1),
        }),
        {
          ...query,
          page:
            query.page === undefined
              ? 1
              : typeof query.page === 'string'
                ? Number(query.page)
                : NaN,
        },
      ),
    );
  }
  @Get('resources/:id') catalogItem(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.studio.catalogItem(req.agentUser, identifier(id));
  }
  @Post('teams') team(@Req() req: AgentRequest, @Body() body: unknown) {
    return this.studio.saveTeam(
      req.agentUser,
      undefined,
      parse(teamInput, body),
    );
  }
  @Patch('teams/:id') changeTeam(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.studio.saveTeam(
      req.agentUser,
      identifier(id),
      parse(teamInput.keys({ revision }), body),
    );
  }
  @Post('stores') shop(@Req() req: AgentRequest, @Body() body: unknown) {
    return this.studio.saveStore(
      req.agentUser,
      undefined,
      parse(storeInput, body),
    );
  }
  @Patch('stores/:id') changeShop(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.studio.saveStore(
      req.agentUser,
      identifier(id),
      parse(storeInput.keys({ revision }), body),
    );
  }
  @Post('resources') resource(@Req() req: AgentRequest, @Body() body: unknown) {
    return this.studio.saveResource(
      req.agentUser,
      parse(
        Joi.object({
          teamId: idSchema.required(),
          name: title,
          type: Joi.string()
            .valid('product', 'skill', 'thumbnail', 'scene')
            .required(),
          code: Joi.string().trim().min(1).max(80).required(),
          instructions: Joi.string().max(40000).allow('').required(),
          assetId: idSchema,
          previousId: idSchema,
          printSpec: Joi.object({
            width: Joi.number().integer().min(64).max(8192).required(),
            height: Joi.number().integer().min(64).max(8192).required(),
            dpi: Joi.number().integer().min(72).max(600).required(),
            background: Joi.string().valid('white', 'transparent').required(),
          }).custom((value: { width: number; height: number }, helpers) =>
            value.width * value.height > 32_000_000
              ? helpers.error('any.invalid')
              : value,
          ),
        }),
        body,
      ),
    );
  }
  @Post('skills/import')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 4 },
    }),
  )
  importSkill(
    @Req() req: AgentRequest,
    @Body() body: unknown,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file?.buffer)
      throw new ApiError(
        400,
        'STUDIO_SKILL_REQUIRED',
        'Hãy chọn file ZIP bộ hướng dẫn.',
      );
    return this.library.import(
      req.agentUser,
      parse(
        Joi.object({
          teamId: idSchema.required(),
          name: title,
          code: Joi.string().trim().min(1).max(80).required(),
          previousId: idSchema,
        }),
        body,
      ),
      file.buffer,
    );
  }
  @Post('resources/:id/review') reviewResource(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<{ revision: number; status: 'approved' | 'archived' }>(
      Joi.object({
        revision,
        status: Joi.string().valid('approved', 'archived').required(),
      }),
      body,
    );
    return this.studio.approveResource(
      req.agentUser,
      identifier(id),
      input.revision,
      input.status,
    );
  }
  @Get('ideas') ideas(
    @Req() req: AgentRequest,
    @Query('page') page?: string,
    @Query('state') state?: string,
  ) {
    const filter = state
      ? parse<string>(
          Joi.string()
            .valid('draft', 'pending', 'approved', 'changes_requested')
            .required(),
          state,
        )
      : undefined;
    return this.studio.ideas(req.agentUser, pageNumber(page), filter);
  }
  @Get('skills/:id/versions') versions(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.library.versions(req.agentUser, identifier(id));
  }
  @Get('skills/:id/bundle') async bundle(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const result = await this.library.download(req.agentUser, identifier(id));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.type('application/zip').send(result.buffer);
  }
  @Post('skills/:id/context') contextImages(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<{ revision: number; paths: string[] }>(
      Joi.object({
        revision,
        paths: Joi.array()
          .items(Joi.string().max(500))
          .max(4)
          .unique()
          .required(),
      }),
      body,
    );
    return this.library.selectContext(
      req.agentUser,
      identifier(id),
      input.revision,
      input.paths,
    );
  }
  @Post('ideas') idea(@Req() req: AgentRequest, @Body() body: unknown) {
    return this.studio.saveIdea(
      req.agentUser,
      undefined,
      parse<IdeaInput>(ideaInput, body),
    );
  }
  @Patch('ideas/:id') changeIdea(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<{ revision: number; input: IdeaInput }>(
      Joi.object({ revision, input: ideaInput.required() }),
      body,
    );
    return this.studio.saveIdea(
      req.agentUser,
      identifier(id),
      input.input,
      input.revision,
    );
  }
  @Get('ideas/:id') detail(@Req() req: AgentRequest, @Param('id') id: string) {
    return this.studio.detail(req.agentUser, identifier(id));
  }
  @Post('ideas/:id/submit') submit(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.studio.submit(
      req.agentUser,
      identifier(id),
      parse<{ revision: number }>(Joi.object({ revision }), body).revision,
    );
  }
  @Post('ideas/:id/review') review(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<{
      revision: number;
      decision: 'approved' | 'changes_requested';
      note: string;
    }>(
      Joi.object({
        revision,
        decision: Joi.string()
          .valid('approved', 'changes_requested')
          .required(),
        note: Joi.string().max(2000).allow('').default(''),
      }),
      body,
    );
    return this.studio.decide(
      req.agentUser,
      identifier(id),
      input.revision,
      input.decision,
      input.note,
    );
  }
  @Post('tickets/:id/cancel') cancel(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.studio.cancel(req.agentUser, identifier(id));
  }
  @Post('tickets/:id/continue') continueSamples(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.studio.continueSamples(req.agentUser, identifier(id));
  }
  @Post('tickets/:id/catch-up') async catchUp(
    @Req() req: AgentRequest,
    @Param('id') id: string,
  ) {
    const ticket = await this.studio.ticket(req.agentUser, identifier(id));
    return adminAction(
      this.studio.store,
      req.agentUser,
      'studio.ticket.catch_up',
      ticket.id,
      {},
      async () => {
        const result = await this.studio.store.patch<StudioTicket>(
          'studio-ticket',
          ticket.id,
          ticket.owner,
          { state: 'queued', catchUpAt: new Date().toISOString() },
          { state: 'missed' },
        );
        if (!result)
          throw new ApiError(
            409,
            'STUDIO_STATE_CHANGED',
            'Chỉ chạy bù lô đã lỡ lịch.',
          );
        return result;
      },
    );
  }
  @Post('tickets/:id/reviews') reviewOutput(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse<{
      assetId: string;
      decision: 'approved' | 'changes_requested';
      note: string;
    }>(
      Joi.object({
        assetId: idSchema.required(),
        decision: Joi.string()
          .valid('approved', 'changes_requested')
          .required(),
        note: Joi.string().max(2000).allow('').default(''),
      }),
      body,
    );
    return this.studio.reviewOutput(
      req.agentUser,
      identifier(id),
      input.assetId,
      input.decision,
      input.note,
    );
  }
  @Get('outputs') outputs(
    @Req() req: AgentRequest,
    @Query('page') page?: string,
  ) {
    return this.studio.outputs(req.agentUser, pageNumber(page));
  }
  @Get('assets/:id') async image(
    @Req() req: AgentRequest,
    @Param('id') id: string,
    @Res() response: Response,
    @Query('preview') preview?: string,
    @Query('format') format?: string,
  ) {
    const asset = await this.studio.imageAccess(req.agentUser, identifier(id));
    if (preview === '1') {
      response
        .type('image/webp')
        .send(
          await this.studio.assets.preview(
            asset.owner,
            asset.id,
            req.agentUser.id,
          ),
        );
      return;
    }
    const { buffer } = await this.studio.assets.read(
      asset.owner,
      asset.id,
      req.agentUser.id,
    );
    if (format === 'png' || format === 'jpg') {
      if (format === 'jpg' && asset.printSpec?.background === 'transparent')
        throw new ApiError(
          400,
          'STUDIO_ALPHA_FORMAT_REQUIRED',
          'Artwork nền trong suốt phải xuất PNG. JPG không giữ kênh trong suốt.',
        );
      const output = sharp(buffer).rotate();
      if (asset.printSpec)
        output.withMetadata({ density: asset.printSpec.dpi });
      response
        .type(format === 'png' ? 'image/png' : 'image/jpeg')
        .send(
          await output.toFormat(format === 'png' ? 'png' : 'jpeg').toBuffer(),
        );
      return;
    }
    response.type(asset.mimeType).send(buffer);
  }
}
