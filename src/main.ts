import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { apiErrorResponses } from './common/api-error.responses';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '2mb' });
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const configService: ConfigService = app.get(ConfigService);
  app.enableCors({
    origin: configService
      .getOrThrow<string>('CORS_ALLOWED_ORIGINS')
      .split(',')
      .map((origin) => origin.trim()),
    exposedHeaders: ['X-Request-Id', 'X-Job-Id'],
  });

  const config = new DocumentBuilder()
    .setTitle('Gemini Image Tools API')
    .setDescription(
      'API upload, edit image with Gemini and store on Cloudflare R2',
    )
    .setVersion('1.0')
    .addGlobalResponse(...apiErrorResponses)
    .build();

  app.setGlobalPrefix('api');

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('/api/docs', app, document);

  await app.listen(configService.get<number>('PORT') || 5177);
}
void bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
