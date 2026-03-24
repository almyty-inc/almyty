import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Response } from 'express';

/**
 * Global response transform interceptor.
 * Ensures ALL API responses follow the same format:
 *   { success: true, data: <payload>, message?: <string> }
 *
 * Exceptions:
 * - Responses already wrapped with { success, data } are not double-wrapped
 * - Streaming/SSE responses are passed through
 * - File download responses (blob) are passed through
 */
@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data) => {
        // Skip if response is streaming (SSE, file download)
        const contentType = response.getHeader('content-type') as string;
        if (
          contentType?.includes('text/event-stream') ||
          contentType?.includes('application/octet-stream') ||
          contentType?.includes('text/csv')
        ) {
          return data;
        }

        // Skip if already wrapped in standard format
        if (
          data &&
          typeof data === 'object' &&
          'success' in data &&
          'data' in data
        ) {
          return data;
        }

        // Skip null/undefined (204 No Content, etc.)
        if (data === null || data === undefined) {
          return data;
        }

        // Wrap the response
        return {
          success: true,
          data,
        };
      }),
    );
  }
}
