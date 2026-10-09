import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';
import { createSpaRootMiddleware } from './common/frontend/frontend-static';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { CorrelatedConsoleLogger } from './common/logging/correlated-console.logger';
import { requestContextMiddleware } from './common/middleware/request-context.middleware';
import { sentryInitOptions } from './common/observability/sentry-options';
import { SurfaceCorsService } from './modules/gateways/channels/surface-cors';
import { csrfOriginCheck } from './common/security/csrf-origin';
import { dashboardAllowedOrigins } from './common/security/allowed-origins';
// No global response interceptor — each controller is responsible for consistent {success, data} format
import { getRepositoryToken } from '@nestjs/typeorm';
import { RequestLog } from './entities/request-log.entity';
import { UsageMetric } from './entities/usage-metric.entity';

// Sentry error tracking — no-op unless SENTRY_DSN is configured. When set,
// initializes @sentry/node once at process start so unhandled exceptions and
// the GlobalExceptionFilter's 5xx reports have a client to send to. Ships
// dark: with no DSN nothing loads, no network, no error. Environment is
// tagged from SENTRY_ENVIRONMENT (falling back to NODE_ENV) so staging and
// production stay separable in one project. Events and breadcrumbs are
// stripped of failed-query parameters (see sentry-options.ts).
const sentryOptions = sentryInitOptions();
if (sentryOptions) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init(sentryOptions);
  } catch {
    // @sentry/node not installed — skip initialization (stays no-op).
  }
}

/** The routes whose JSON bodies may be as large as a coding CLI's model call (the model pass-through). */
export const MODEL_PASSTHROUGH_ROUTES = ['/v1/messages', '/v1/chat/completions', '/v1/responses'];

/**
 * The application, configured exactly as it serves (middleware, parsers,
 * CORS, pipes, filters, interceptors), not yet listening.
 */
export async function createApp() {
  const logger = new Logger('Bootstrap');
  
  const app = await NestFactory.create(AppModule, {
    // Every log line carries the correlation fields of the request (or
    // job) it happened in — see CorrelatedConsoleLogger. Same console
    // format, same levels, with ` | req=… org=… run=…` appended.
    logger: new CorrelatedConsoleLogger({
      logLevels: ['log', 'error', 'warn', 'debug', 'verbose'],
    }),
    // Preserve the raw request body so the Stripe billing webhook can verify
    // its signature over the exact bytes Stripe signed (JSON re-serialization
    // would break the HMAC). Nest still parses JSON for every other route.
    rawBody: true,
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  // Correlation id — FIRST, before every other middleware, so the whole
  // request (guards, interceptors, handler, exception filter) runs inside
  // the AsyncLocalStorage scope and the id is on the response header even
  // for a request that never reaches a handler.
  app.use(requestContextMiddleware);

  // A coding CLI in a hosted pod sends its whole conversation and tool list
  // on every model call, routinely past the default 100kb JSON limit. The
  // model routes parse their own JSON with a larger one (Nest's parser then
  // sees the body already read); every other route keeps the default.
  //
  // Wrapped, not passed as is: Nest skips installing its own JSON parser
  // when the app already has a middleware whose function is named
  // `jsonParser`, which is what express's json() returns. Registered bare,
  // this one parser became the only one, and every other route got an
  // empty body (sign-up answered "email should not be empty").
  const modelRouteParser = json({ limit: process.env.MODEL_PASSTHROUGH_BODY_LIMIT || '32mb' });
  app.use(MODEL_PASSTHROUGH_ROUTES, function modelRouteJsonParser(req: any, res: any, next: (err?: unknown) => void) {
    return modelRouteParser(req, res, next);
  });

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
  // The allowlist (CORS_ALLOWED_ORIGINS, FRONTEND_URL, ADMIN_URL, plus the
  // local dev server outside production) comes from one builder, shared
  // with the MCP Origin check -- see common/security/allowed-origins.ts.
  const allowedOrigins = dashboardAllowedOrigins((name) => configService.get<string>(name));

  // Every route but the public chat surfaces keeps exactly this policy: no
  // Origin header (server-to-server, curl, same-origin) is fine, otherwise
  // the origin must be on the allowlist; fail closed for everything else.
  //
  // The widget and hosted-chat public routes are answered per gateway from
  // that surface's own allowed-origins list, exact match, never with
  // credentials -- see SurfaceCorsService.
  app.enableCors(
    app.get(SurfaceCorsService).delegate(allowedOrigins, {
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Retry-Count', 'X-Organization-Id', 'Mcp-Protocol-Version', 'Mcp-Session-Id'],
      exposedHeaders: ['Mcp-Session-Id'],
    }),
  );

  // Cookie-authenticated writes must come from an origin we serve: the
  // same allowlist, plus the API's own origin. See csrf-origin.ts.
  app.use(csrfOriginCheck(allowedOrigins));

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

  return { app, port, logger };
}

async function bootstrap() {
  const { app, port, logger } = await createApp();
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
}

// `node dist/main` starts the server; a spec imports createApp and boots
// the very same configuration on a port of its own.
if (require.main === module) {
  void bootstrap();
}
