import { Controller, Get } from '@nestjs/common';
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
}
