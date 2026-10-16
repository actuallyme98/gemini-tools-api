import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AIService } from './ai.service';

@ApiTags('AI')
@Controller('ai')
export class AIController {
  constructor(private readonly aiService: AIService) {}

  @Get('providers')
  @ApiOperation({
    summary:
      'List configured provider capabilities and effective request routing',
  })
  getProviders() {
    return this.aiService.getProviders();
  }

  @Get('providers/:provider/image-models')
  @ApiOperation({
    summary:
      'List compatible image models from the selected provider. refresh=true bypasses the catalog cache.',
  })
  getImageModels(
    @Param('provider') provider: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.aiService.getImageModels(provider, refresh === 'true');
  }
}
