import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { Response, Request } from 'express';

/**
 * Catches JSON parse errors on A2A endpoints and returns proper
 * JSON-RPC -32700 Parse Error instead of HTTP 400.
 *
 * Must be registered BEFORE the GlobalExceptionFilter so it
 * intercepts first. Only handles parse errors on JSON content-type
 * POST requests — all other errors pass through.
 */
@Catch()
export class JsonRpcParseErrorFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Only intercept POST requests with JSON content type
    if (request.method !== 'POST') {
      this.passThrough(exception, response);
      return;
    }

    const contentType = request.headers?.['content-type'] || '';
    if (!contentType.includes('application/json')) {
      this.passThrough(exception, response);
      return;
    }

    // Check if this is a JSON parse error
    const message = exception?.message || '';
    const isParseError = exception instanceof SyntaxError
      || message.includes('JSON')
      || message.includes('Unexpected')
      || message.includes('position')
      || (exception?.status === 400 && message.includes('at position'));

    if (isParseError) {
      response.status(200).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    this.passThrough(exception, response);
  }

  private passThrough(exception: any, _response: Response): void {
    // Re-throw so the next filter (GlobalExceptionFilter) handles it
    throw exception;
  }
}
