import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './common/env.validation';
import { MockupModule } from './mockup/mockup.module';
import { IdeaModule } from './idea/idea.module';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    MockupModule,
    IdeaModule,
  ],
})
export class AppModule {}
