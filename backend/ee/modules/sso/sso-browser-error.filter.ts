import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ssoErrorRedirect, ssoFailureCode } from './sso.util';

/**
 * The dashboard SSO routes are pages a browser navigates to, so a refusal
 * there (a deactivated member, an expired sign-in) showed the person a raw
 * JSON error. A browser asking for HTML is sent to the sign-in error page
 * with the reason instead; anything else (an API client, a test) still
 * gets the status and JSON body it always did.
 */
@Catch()
export class SsoBrowserErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(SsoBrowserErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (wantsHtml(req)) {
      if (status >= 500) this.logger.error(`SSO sign-in failed: ${(exception as Error)?.message ?? exception}`);
      res.redirect(303, ssoErrorRedirect(ssoFailureCode(exception)));
      return;
    }

    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' };
    res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}

/** A browser navigation: the request prefers HTML over JSON. */
export function wantsHtml(req: Request): boolean {
  try {
    return req.accepts(['json', 'html']) === 'html';
  } catch {
    return false;
  }
}
