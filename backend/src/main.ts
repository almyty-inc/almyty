import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { createSpaRootMiddleware } from './common/frontend/frontend-static';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
// No global response interceptor — each controller is responsible for consistent {success, data} format
import { getRepositoryToken } from '@nestjs/typeorm';
import { RequestLog } from './entities/request-log.entity';
import { UsageMetric } from './entities/usage-metric.entity';

// Sentry error tracking — no-op unless SENTRY_DSN is configured. When set,
// initializes @sentry/node once at process start so unhandled exceptions and
// the GlobalExceptionFilter's 5xx reports have a client to send to. Ships
// dark: with no DSN nothing loads, no network, no error. Environment is
// tagged from SENTRY_ENVIRONMENT (falling back to NODE_ENV) so staging and
// production stay separable in one project.
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment:
        process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      // Error tracking only by default — no performance tracing until
      // explicitly opted into. Keeps overhead negligible.
      tracesSampleRate: 0,
    });
  } catch {
    // @sentry/node not installed — skip initialization (stays no-op).
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
    // Preserve the raw request body so the Stripe billing webhook can verify
    // its signature over the exact bytes Stripe signed (JSON re-serialization
    // would break the HMAC). Nest still parses JSON for every other route.
    rawBody: true,
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

  // Performance middleware. Skip Server-Sent Events: compression buffers the
  // response to gzip it, which stalls SSE (events never flush to the client)
  // and leaves long-lived streams idle until the proxy closes them. The
  // streamable transport also sets `Cache-Control: no-transform`; this filter
  // is the belt-and-suspenders that covers every SSE endpoint.
  app.use(
    compression({
      filter: (req, res) => {
        const ct = String(res.getHeader('Content-Type') ?? '');
        if (ct.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(cookieParser());

  // Single-image (almyty/almyty) SPA root fallback. Serves index.html for a
  // bare `GET /` HTML navigation, which the unified gateway's `@All('/')`
  // controller would otherwise shadow. No-op (null) for the api-only image.
  const spaRootMiddleware = createSpaRootMiddleware();
  if (spaRootMiddleware) {
    app.use(spaRootMiddleware);
  }

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