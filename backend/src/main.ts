import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as compression from 'compression';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
// No global response interceptor — each controller is responsible for consistent {success, data} format
import { getRepositoryToken } from '@nestjs/typeorm';
import { RequestLog } from './entities/request-log.entity';
import { UsageMetric } from './entities/usage-metric.entity';

// Sentry error tracking — enabled when SENTRY_DSN is configured
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
    });
  } catch {
    // @sentry/node not installed — skip initialization
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  }));

  // Performance middleware
  app.use(compression());
  app.use(cookieParser());

  // CORS configuration — origin allowlist from env, NOT `origin: true`.
  //
  // The previous config set `origin: true`, which reflects whatever
  // `Origin` header the request carried. Combined with
  // `credentials: true` this told every browser that we're willing
  // to send/receive cookies and auth headers to any origin — which
  // modern browsers block at the preflight level, but which is
  // still a dangerous default: any reverse proxy or middleware
  // that normalizes/echoes the origin could accidentally bypass
  // the browser safety and allow credentialed XHR from attacker
  // sites. Pin to a concrete allowlist and fail closed for
  // everything else.
  //
  // The allowlist is built from these env vars, in order:
  //   CORS_ALLOWED_ORIGINS   comma-separated explicit list
  //   FRONTEND_URL           the primary web UI (always included)
  //   ADMIN_URL              optional admin panel (if deployed)
  // Plus localhost:3002 in non-production for local dev.
  const envOrigins = (configService.get<string>('CORS_ALLOWED_ORIGINS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = new Set<string>(envOrigins);
  const frontendUrl = configService.get<string>('FRONTEND_URL');
  if (frontendUrl) allowedOrigins.add(frontendUrl);
  const adminUrl = configService.get<string>('ADMIN_URL');
  if (adminUrl) allowedOrigins.add(adminUrl);
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:3002');
    allowedOrigins.add('http://127.0.0.1:3002');
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Same-origin / server-to-server requests have no Origin
      // header; allow those through (the browser protection only
      // matters for cross-origin XHR).
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin "${origin}" not in allowlist`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Retry-Count', 'X-Organization-Id'],
  });

  // No API prefix - this is a pure API backend

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false, // Disabled for performance - use explicit @Type() decorators
      },
    }),
  );

  // Swagger documentation (disabled in production via SWAGGER_ENABLED=false)
  const swaggerEnabled = configService.get<string>('SWAGGER_ENABLED', 'true') === 'true';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('almyty API')
      .setDescription('almyty - Universal API to AI Tool Gateway System')
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'JWT',
          description: 'Enter JWT token',
          in: 'header',
        },
        'JWT-auth',
      )
      .addApiKey(
        {
          type: 'apiKey',
          name: 'X-API-Key',
          in: 'header',
          description: 'API Key for service authentication',
        },
        'API-Key',
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
    logger.log(`Swagger documentation: http://localhost:${port}/docs`);
  }

  // Global exception filter — standardized error responses, no internal leaks
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Request logging — records every request to RequestLog + UsageMetric tables
  const requestLogRepo = app.get(getRepositoryToken(RequestLog));
  const usageMetricRepo = app.get(getRepositoryToken(UsageMetric));
  app.useGlobalInterceptors(
    new RequestLoggingInterceptor(requestLogRepo, usageMetricRepo),
  );

  // Graceful shutdown hooks for k8s SIGTERM
  app.enableShutdownHooks();

  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();