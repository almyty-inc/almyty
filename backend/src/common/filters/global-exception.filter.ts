import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError, EntityNotFoundError } from 'typeorm';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // JSON-RPC -32700 parse error for malformed JSON on A2A/gateway POST requests.
    // Only applies to paths that serve JSON-RPC (root /, gateway sub-paths).
    // Internal API endpoints (/auth, /agents, /gateways, etc.) keep normal HTTP errors.
    if (request.method === 'POST') {
      const path = request.path || '';
      const isInternalApi = path.startsWith('/auth') || path.startsWith('/agents')
        || path.startsWith('/gateways') || path.startsWith('/apis')
        || path.startsWith('/tools') || path.startsWith('/health')
        || path.startsWith('/users') || path.startsWith('/organizations')
        || path.startsWith('/credentials') || path.startsWith('/mcp');
      const ct = request.headers?.['content-type'] || '';
      const errMsg = (exception as any)?.message || '';
      const isParseError = !isInternalApi && ct.includes('application/json') && (
        exception instanceof SyntaxError
        || errMsg.includes('JSON at position')
        || errMsg.includes('Unexpected token')
        || errMsg.includes('Expected')
      );
      if (isParseError) {
        response.status(200).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON' },
        });
        return;
      }
    }

    let status: number;
    let message: string;
    let code: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();
      message = typeof exResponse === 'string'
        ? exResponse
        : (exResponse as any).message || exception.message;
      // Honour a machine-readable `code` set on the exception payload
      // (e.g. ForbiddenException({ code: 'EMAIL_NOT_VERIFIED', ... })) so
      // callers can branch on a stable code rather than parsing the human
      // message. Falls back to the status-derived code when none is set.
      code = (typeof exResponse === 'object' && exResponse !== null && (exResponse as any).code)
        ? String((exResponse as any).code)
        : this.getCodeFromStatus(status);

      // Flatten array messages from ValidationPipe
      if (Array.isArray(message)) {
        message = message.join('; ');
      }

      // Set WWW-Authenticate header on 401 responses (per HTTP/A2A/UTCP specs)
      if (status === 401 && (exception as any).wwwAuthenticate) {
        response.setHeader('WWW-Authenticate', (exception as any).wwwAuthenticate);
      }
    } else if (exception instanceof QueryFailedError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Database operation failed';
      code = 'DATABASE_ERROR';
      this.logger.error(
        `Database error on ${request.method} ${request.path}: ${(exception as any).message}`,
        (exception as any).stack,
      );
    } else if (exception instanceof EntityNotFoundError) {
      status = HttpStatus.NOT_FOUND;
      message = 'Resource not found';
      code = 'NOT_FOUND';
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      code = 'INTERNAL_ERROR';
      this.logger.error(
        `Unhandled error on ${request.method} ${request.path}: ${exception.message}`,
        exception.stack,
      );
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      code = 'INTERNAL_ERROR';
      this.logger.error(`Unknown error on ${request.method} ${request.path}`, exception);
    }

    // Report server-side failures (5xx) to Sentry — including thrown
    // HttpExceptions that resolve to a 5xx (e.g. ServiceUnavailable). 4xx
    // are client errors and are never reported. Log a structured 5xx line
    // (method, path, status) so failures are traceable even when Sentry
    // is dark. No-op when SENTRY_DSN is unset.
    if (status >= 500) {
      this.logger.error(
        `5xx on ${request.method} ${request.path} -> ${status}: ${message}`,
      );
      this.captureToSentry(exception);
    }

    response.status(status).json({
      error: {
        code,
        message,
        statusCode: status,
        timestamp: new Date().toISOString(),
        path: request.path,
      },
    });
  }

  private captureToSentry(exception: unknown): void {
    try {
      const Sentry = require('@sentry/node');
      if (Sentry.isInitialized?.()) {
        Sentry.captureException(exception);
      }
    } catch {
      // @sentry/node not installed — skip
    }
  }

  private getCodeFromStatus(status: number): string {
    switch (status) {
      case 400: return 'BAD_REQUEST';
      case 401: return 'UNAUTHORIZED';
      case 403: return 'FORBIDDEN';
      case 404: return 'NOT_FOUND';
      case 409: return 'CONFLICT';
      case 422: return 'UNPROCESSABLE_ENTITY';
      case 429: return 'RATE_LIMITED';
      default: return status >= 500 ? 'INTERNAL_ERROR' : 'CLIENT_ERROR';
    }
  }
}
