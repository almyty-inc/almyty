import { ExceptionFilter, Catch, ArgumentsHost, BadRequestException } from '@nestjs/common';
import { Response } from 'express';

/**
 * Catches NestJS BadRequestException (thrown for malformed JSON body)
 * and returns a proper JSON-RPC -32700 Parse Error response.
 *
 * Applied to A2A endpoints so TCK compliance tests pass.
 */
@Catch(BadRequestException)
export class JsonRpcParseErrorFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    // Only intercept on A2A-like paths (root POST or gateway POST with JSON-RPC content type)
    const contentType = request.headers?.['content-type'] || '';
    const isJsonRpc = contentType.includes('application/json');
    const exceptionResponse = exception.getResponse();
    const isParseError = typeof exceptionResponse === 'object'
      && (exceptionResponse as any)?.message?.includes?.('JSON')
      || exception.message.includes('JSON')
      || exception.message.includes('Unexpected');

    if (isJsonRpc && isParseError) {
      response.status(200).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    // Not a JSON-RPC parse error — rethrow as normal HTTP error
    response.status(exception.getStatus()).json(exceptionResponse);
  }
}
