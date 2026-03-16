import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * MCP Auth Exception Filter
 *
 * Per MCP spec (OAuth 2.1), 401 responses MUST include a WWW-Authenticate header
 * that tells clients how to authenticate. This filter intercepts HttpExceptions
 * and adds the header when the gateway resolver attaches wwwAuthenticate info.
 */
@Catch(HttpException)
export class McpAuthExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();

    // Add WWW-Authenticate header if present on the exception
    const wwwAuthenticate = (exception as any).wwwAuthenticate;
    if (wwwAuthenticate && status === HttpStatus.UNAUTHORIZED) {
      response.setHeader('WWW-Authenticate', wwwAuthenticate);
    }

    const exceptionResponse = exception.getResponse();
    const body = typeof exceptionResponse === 'string'
      ? { error: { code: 'UNAUTHORIZED', message: exceptionResponse, statusCode: status } }
      : {
          error: {
            code: (exceptionResponse as any).errorCode || 'UNAUTHORIZED',
            message: (exceptionResponse as any).error || (exceptionResponse as any).message || 'Authentication required',
            statusCode: status,
            timestamp: new Date().toISOString(),
          },
        };

    response.status(status).json(body);
  }
}
