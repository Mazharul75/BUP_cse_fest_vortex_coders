import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      // Structurally invalid bodies are rejected with HTTP 400 (Problem Statement 06.1).
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  const port = Number(process.env.PORT ?? 8000);
  // Bind to every interface so the container and the judge harness can reach it.
  await app.listen(port, '0.0.0.0');
  console.log(`GridWise API listening on 0.0.0.0:${port}`);
}

bootstrap();
