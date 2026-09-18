import type { NextFunction, Request, Response } from 'express';

import {
  REQUEST_ID_HEADER,
  newRequestId,
  runWithRequestContext,
  sanitizeInboundRequestId,
} from '../request-context';

/**
 * Mints the correlation id for an inbound request and opens the
 * AsyncLocalStorage scope everything downstream reads from.
 *
 * Installed as the first middleware in `bootstrap()` so that every
 * later middleware, guard, interceptor, handler and exception filter
 * runs inside the scope. The id is echoed as `X-Request-Id` before the
 * handler runs, so it is on the response even when the handler throws
 * and the global filter answers instead.
 *
 * An inbound `x-request-id` is honoured when it is well-formed, so a
 * proxy or a client retry keeps one id across hops; anything else is
 * replaced with a fresh uuid rather than trusted into a log line.
 */
export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = sanitizeInboundRequestId(req.headers?.[REQUEST_ID_HEADER]);
  const requestId = inbound ?? newRequestId();

  // Make it reachable from plain `req` too: a few express-level helpers
  // (RequestLog.fromHttpRequest) and third-party middleware see only the
  // request object, never our storage.
  (req as Record<string, any>).requestId = requestId;
  try {
    res.setHeader('X-Request-Id', requestId);
  } catch {
    // Headers already sent (an earlier middleware answered) — the id is
    // still on the request and in the scope, which is what logs read.
  }

  runWithRequestContext({ requestId }, () => next());
}
