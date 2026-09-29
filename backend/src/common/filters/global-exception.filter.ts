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

import { redactQueryError } from '../errors/redact-query-error';
import { getRequestContext, getRequestId } from '../request-context';

/**
 * Errors body-parser raises before the route handler runs. They are plain
 * Errors with a 4xx `status` and a machine-readable `type` (see
 * github.com/expressjs/body-parser#errors).
 */
interface BodyParserError extends Error {
  status: number;
  type: string;
}

/**
 * Keys the filter owns in the error body. Everything else on an
 * exception payload belongs to whoever threw it and is forwarded.
 */
const RESERVED_ERROR_KEYS = new Set(['code', 'message', 'statusCode', 'timestamp', 'path', 'error']);

const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.too.large': 'Request body too large',
  'encoding.unsupported': 'Unsupported content encoding',
  'charset.unsupported': 'Unsupported charset',
  'entity.verify.failed': 'Request body failed verification',
  'entity.parse.failed': 'Malformed request body',
  'request.aborted': 'Request aborted',
  'request.size.invalid': 'Request size did not match Content-Length',
  'stream.encoding.set': 'Invalid request stream',
  'stream.not.readable': 'Invalid request stream',
  'parameters.too.many': 'Too many parameters',
};

/**
 * Postgres SQLSTATE classes, plus the socket-level codes the driver
 * raises before it ever gets a SQLSTATE, that mean "the database is not
 * answering" rather than "your data is wrong".
 *
 *   08xxx  connection exception
 *   53xxx  insufficient resources (out of connections, disk, memory)
 *   57P01  admin shutdown        57P02  crash shutdown
 *   57P03  cannot connect now    57014  query cancelled (statement timeout)
 *   40001  serialization failure 40P01  deadlock detected
 *
 * A constraint violation (23xxx), an undefined column (42xxx) or a bad
 * cast (22xxx) is not here: those really are 4xx.
 */
const DB_UNAVAILABLE_SQLSTATES = new Set([
  '57P01', '57P02', '57P03', '57014', '40001', '40P01',
]);
const DB_UNAVAILABLE_DRIVER_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND',
]);

export function isConnectionClassDatabaseError(exception: unknown): boolean {
  const err = exception as any;
  const driver = err?.driverError ?? err;
  const code = driver?.code ?? err?.code;
  if (typeof code === 'string') {
    if (DB_UNAVAILABLE_DRIVER_CODES.has(code)) return true;
    if (DB_UNAVAILABLE_SQLSTATES.has(code)) return true;
    if (/^(08|53)/.test(code)) return true;
  }
  // TypeORM raises these as plain Errors with no SQLSTATE at all when the
  // pool itself is gone, so the message is the only signal available.
  const message = String(driver?.message ?? err?.message ?? '');
  return /connection terminated|connection ended|pool is draining|timeout exceeded when trying to connect|Client has encountered a connection error|too many clients/i.test(
    message,
  );
}

function isBodyParserError(exception: unknown): exception is BodyParserError {
  if (!(exception instanceof Error)) return false;
  const { status, type } = exception as Partial<BodyParserError>;
  return typeof status === 'number' && status >= 400 && status < 500 && typeof type === 'string';
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // A failed query's error carries the row it was writing. Redacted
    // before any log line or Sentry report here can pass it on.
    redactQueryError(exception);

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
        || path.startsWith('/credentials') || path.startsWith('/mcp') || path.startsWith('/public');
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
    /** Extra fields the thrower put on the payload, forwarded as-is. */
    let details: Record<string, unknown> = {};

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

      // Anything else on the payload is the thrower's own structured
      // detail, meant for the client: `accepts` on an unsupported source,
      // `retryAfter`, a field list. Forward it rather than discarding it.
      if (typeof exResponse === 'object' && exResponse !== null) {
        details = Object.fromEntries(
          Object.entries(exResponse as Record<string, unknown>).filter(
            ([k]) => !RESERVED_ERROR_KEYS.has(k),
          ),
        );
      }

      // Flatten array messages from ValidationPipe
      if (Array.isArray(message)) {
        message = message.join('; ');
      }

      // Set WWW-Authenticate header on 401 responses (per HTTP/A2A/UTCP specs)
      if (status === 401 && (exception as any).wwwAuthenticate) {
        response.setHeader('WWW-Authenticate', (exception as any).wwwAuthenticate);
      }
    } else if (exception instanceof QueryFailedError) {
      // A constraint violation is the client's fault; a dead pool, a
      // refused socket or a statement timeout is ours. Mapping both to
      // 400 meant a database outage was counted as a client error,
      // never reported to Sentry, and invisible to any 5xx-rate alert.
      const connectionClass = isConnectionClassDatabaseError(exception);
      status = connectionClass
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.BAD_REQUEST;
      message = connectionClass
        ? 'Service temporarily unavailable'
        : 'Database operation failed';
      code = connectionClass ? 'DATABASE_UNAVAILABLE' : 'DATABASE_ERROR';
      this.logger.error(
        `Database error on ${request.method} ${request.path}: ` +
          `${(exception as any).code ?? 'no-code'} ${(exception as any).message}`,
        (exception as any).stack,
      );
    } else if (exception instanceof EntityNotFoundError) {
      status = HttpStatus.NOT_FOUND;
      message = 'Resource not found';
      code = 'NOT_FOUND';
    } else if (isBodyParserError(exception)) {
      // body-parser rejects a request before any handler runs (payload over
      // the size limit, unsupported encoding, ...). It throws a plain Error
      // carrying the right HTTP status, so honour that instead of turning a
      // client mistake into a 500 that pages someone.
      status = exception.status;
      message = BODY_PARSER_MESSAGES[exception.type] ?? 'Invalid request body';
      code = this.getCodeFromStatus(status);
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

    // The correlation id of this request. Answered to the client so a
    // person can quote it ("it said Internal server error, request
    // a1b2c3"), echoed as a header so a browser devtools capture has it
    // too, and the same id every log line for this request carries — so
    // a 500 the user saw has exactly one grep.
    const requestId = getRequestId() ?? (request as any).requestId ?? null;
    if (requestId) {
      try {
        response.setHeader('X-Request-Id', requestId);
      } catch {
        // Already sent — the body still carries it.
      }
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
      this.captureToSentry(exception, request, status, code, requestId);
    }

    response.status(status).json({
      // A sibling copy of the reason, at the top level.
      //
      // 63 frontend files read `response.data.message` and this filter
      // only ever set `error.message`, so every one of them fell through
      // to a generic string: a signup rejected for "Organization name
      // must be at least 2 characters long" told the person "Please check
      // your information and try again", and the shared QueryError
      // component showed axios's "Request failed with status code 400" in
      // 27 places. Fixing the readers one at a time leaves the next one
      // to make the same mistake; answering in both shapes does not.
      //
      // `success: false` for the same reason -- the success envelope has
      // it, and code that branches on it treated an error body as a
      // success because the key was simply absent.
      success: false,
      message,
      ...(requestId ? { requestId } : {}),
      error: {
        code,
        message,
        statusCode: status,
        timestamp: new Date().toISOString(),
        path: request.path,
        ...(requestId ? { requestId } : {}),
        // Whatever else the thrower attached to the payload. Without this
        // the body was rebuilt from five fixed fields, so a handler that
        // threw `{ code, message, accepts }` to tell the client what it
        // could have sent instead had that stripped on the way out, and
        // the unit test asserting it passed because it never crossed the
        // wire. Reserved keys are excluded so they cannot be overridden.
        ...details,
      },
    });
  }

  /**
   * Send the error to Sentry with the scope that makes it filterable.
   *
   * `captureException(exception)` on its own produced an event with no
   * organization, no user and no request id, so the question a Sentry
   * alert exists to answer — "which customer is hitting this?" — had no
   * answer, and two unrelated 500s on different tenants looked like one
   * issue. Tags are set on an isolated scope so they cannot leak into a
   * concurrent request's event.
   */
  private captureToSentry(
    exception: unknown,
    request: Request,
    status: number,
    code: string,
    requestId: string | null,
  ): void {
    try {
      const Sentry = require('@sentry/node');
      if (!Sentry.isInitialized?.()) return;

      const ctx = getRequestContext();
      const user = (request as any)?.user;
      const organizationId = ctx?.organizationId ?? user?.currentOrganizationId ?? null;

      const withScope = (scope: any) => {
        if (requestId) scope.setTag('request_id', requestId);
        if (organizationId) scope.setTag('organization_id', organizationId);
        if (ctx?.runId) scope.setTag('run_id', ctx.runId);
        if (ctx?.gatewayId) scope.setTag('gateway_id', ctx.gatewayId);
        scope.setTag('error_code', code);
        scope.setTag('http_status', String(status));
        scope.setTag('http_route', `${request.method} ${request.path}`);
        // Id only — never an email or a name. An error report is not a
        // place to widen who holds personal data.
        if (user?.id) scope.setUser({ id: user.id });
        scope.setContext?.('request', {
          method: request.method,
          path: request.path,
          requestId,
          organizationId,
        });
        Sentry.captureException(exception);
      };

      if (typeof Sentry.withIsolationScope === 'function') {
        Sentry.withIsolationScope(withScope);
      } else if (typeof Sentry.withScope === 'function') {
        Sentry.withScope(withScope);
      } else {
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
      case 413: return 'PAYLOAD_TOO_LARGE';
      case 415: return 'UNSUPPORTED_MEDIA_TYPE';
      case 422: return 'UNPROCESSABLE_ENTITY';
      case 429: return 'RATE_LIMITED';
      case 500: return 'INTERNAL_ERROR';
      case 501: return 'NOT_IMPLEMENTED';
      case 502: return 'BAD_GATEWAY';
      case 503: return 'SERVICE_UNAVAILABLE';
      case 504: return 'GATEWAY_TIMEOUT';
    }
    // There was no default, so a 500 or 503 HttpException thrown without
    // an explicit code returned undefined and JSON.stringify dropped the
    // `code` key entirely — the client got an error body with no machine
    // -readable reason at all. Never return undefined from here.
    if (status >= 500) return 'INTERNAL_ERROR';
    if (status >= 400) return 'REQUEST_FAILED';
    return 'ERROR';
  }
}
