import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './common/env.validation';
import { MockupModule } from './mockup/mockup.module';
import { IdeaModule } from './idea/idea.module';
import { HealthController } from './health.controller';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { BackgroundModule } from './background/background.module';
import { AuditModule } from './audit/audit.module';
import { AgentModule } from './agent/agent.module';

@Module({
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    AuditModule,
    MockupModule,
    IdeaModule,
    BackgroundModule,
    AgentModule,
  ],
})
export class AppModule {}
