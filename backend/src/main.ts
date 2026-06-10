import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import cookieParser from 'cookie-parser';
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
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // No Origin header (server-to-server, curl, same-origin) is fine —
      // CORS only governs browser cross-origin requests. Otherwise the
      // origin must be on the allowlist; fail closed for everything else.
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Retry-Count', 'X-Organization-Id', 'Mcp-Protocol-Version', 'Mcp-Session-Id'],
    exposedHeaders: ['Mcp-Session-Id'],
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

  // Swagger documentation. Default FAIL-CLOSED: unless
  // SWAGGER_ENABLED is explicitly set to 'true', the /docs
  // endpoint is not mounted at all. Previously the default was
  // 'true', which meant any deployment that forgot to set the
  // env var exposed its full API schema (every route, every DTO,
  // every auth method) to anonymous callers. The k8s configmap
  // sets this to 'false' for production but a hand-rolled
  // deployment would have shipped with docs open.
  const swaggerEnabled = configService.get<string>('SWAGGER_ENABLED', 'false') === 'true';
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

  // JSON parse error handler at Express level.
  // NestJS body parser catches SyntaxError internally, so we intercept
  // via the GlobalExceptionFilter instead. See GlobalExceptionFilter.

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