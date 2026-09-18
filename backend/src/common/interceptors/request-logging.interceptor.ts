import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric, MetricType, MetricStatus } from '../../entities/usage-metric.entity';
import { getProtocolContext } from './protocol-context';
import { getRequestId, updateRequestContext } from '../request-context';

/** Characters of a request/response body kept in the request log. */
export const REQUEST_LOG_BODY_LIMIT = 10000;

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggingInterceptor.name);

  constructor(
    @InjectRepository(RequestLog)
    private readonly requestLogRepository: Repository<RequestLog>,
    @InjectRepository(UsageMetric)
    private readonly usageMetricRepository: Repository<UsageMetric>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest();
    const response = httpContext.getResponse();
    const startTime = Date.now();

    // The log/skip decision happens AFTER the handler ran (in logRequest),
    // not here: protocol traffic to the unified endpoint
    // (`/:orgSlug/:resourceSlug`) is only recognizable once the handler
    // has resolved the gateway and attached a ProtocolContext.
    return next.handle().pipe(
      tap(async (responseBody) => {
        await this.logRequest(request, response, startTime, responseBody, null);
      }),
      catchError(async (error) => {
        await this.logRequest(request, response, startTime, null, error);
        throw error;
      }),
    );
  }

  private async logRequest(
    request: any,
    response: any,
    startTime: number,
    responseBody: any,
    error: any,
  ): Promise<void> {
    try {
      const path = request.path || request.url;
      const protocolContext = getProtocolContext(request);

      // Only log protocol/gateway requests and tool executions — NOT internal
      // management API calls. Internal calls (GET /apis, GET /gateways, etc.)
      // are the frontend talking to its own API and would pollute analytics.
      if (!protocolContext && !this.isProtocolRequest(path)) {
        return;
      }

      const responseTime = Date.now() - startTime;
      const statusCode = error?.status || error?.getStatus?.() || response.statusCode || 500;

      // Handlers that inject @Res() return the Express response object
      // itself (res.json(...) returns res). Serializing it throws on the
      // circular structure, which used to abort the whole log write for
      // every unified-endpoint request. Don't try to record that body.
      if (responseBody === response) {
        responseBody = null;
      }

      // Attribution: prefer the context set by the handler that resolved the
      // gateway — the URL alone can't identify gateway or protocol for
      // multi-tenant paths like /acme/petstore-mcp.
      const gatewayId = protocolContext?.gatewayId || request.params?.gatewayId || null;
      const toolId = request.params?.toolId || this.extractToolId(path) || null;
      const userId = request.user?.id || null;
      const organizationId =
        request.user?.currentOrganizationId || protocolContext?.organizationId || null;
      const protocol = protocolContext?.protocol || this.detectProtocol(path);

      // Feed what the handler resolved back into the correlation scope.
      // The middleware could only mint the id; who the caller is and
      // which gateway answered are known only now, and every log line
      // emitted for the rest of this request picks them up.
      updateRequestContext({ organizationId, userId, gatewayId });

      // Create request log
      const log = new RequestLog();
      log.method = request.method;
      log.path = path;
      log.userAgent = request.headers?.['user-agent'] || null;
      log.ipAddress = request.ip || request.connection?.remoteAddress || null;
      log.statusCode = statusCode;
      log.responseTime = responseTime;
      log.gatewayId = gatewayId;
      log.organizationId = organizationId;
      log.toolId = toolId;
      log.userId = userId;
      // Serialize each body exactly once. This used to run `JSON.stringify`
      // three times per body — `truncateBody` once and `estimateSize` twice
      // (the request log's `*Size` columns and the metric's identical
      // `metadata.*Size`) — so a 10 MB tool result cost six full
      // serialization passes on the response path, on the event loop, before
      // being truncated to 10,000 characters anyway.
      const requestPayload = this.serializeOnce(request.body);
      const responsePayload = this.serializeOnce(responseBody);

      log.requestHeaders = this.sanitizeHeaders(request.headers);
      log.requestBody = requestPayload.truncated;
      log.responseBody = responsePayload.truncated;
      log.errorMessage = this.errorMessageOf(error);
      log.errorCode = this.errorCodeOf(error);
      // The minted correlation id, not whatever the caller happened to
      // send. The header is still honoured upstream (the middleware
      // adopts a well-formed inbound `x-request-id`), so this is the same
      // value the caller sees in `X-Request-Id` either way — but it is
      // never null now, which is what made this column unjoinable.
      log.requestId = getRequestId() || request.requestId || null;
      log.requestSize = requestPayload.size;
      log.responseSize = responsePayload.size;
      log.timestamp = new Date();
      log.metadata = {
        protocol,
        organizationId,
        controller: this.extractController(path),
        // Which gateway auth config refused, when one did. Diagnostics
        // the resolver attached to the exception rather than to its
        // payload: this belongs in our record, not in the answer to an
        // unauthenticated caller.
        ...(error?.authDiagnostics ? { auth: error.authDiagnostics } : {}),
        ...(this.rateLimitBucketOf(error) ? { rateLimit: this.rateLimitBucketOf(error) } : {}),
      };

      // Save async — don't block the response
      this.requestLogRepository.save(log).catch(err => {
        this.logger.warn(`Failed to save request log: ${err.message}`);
      });

      // Also record usage metrics
      const metric = new UsageMetric();
      metric.type = MetricType.REQUEST_COUNT;
      metric.value = 1;
      metric.status = statusCode < 400 ? MetricStatus.SUCCESS :
                      statusCode === 429 ? MetricStatus.RATE_LIMITED :
                      statusCode === 401 || statusCode === 403 ? MetricStatus.UNAUTHORIZED :
                      MetricStatus.ERROR;
      metric.gatewayId = gatewayId;
      metric.toolId = toolId;
      metric.userId = userId;
      metric.organizationId = organizationId;
      metric.timestamp = new Date();
      metric.metadata = {
        endpoint: path,
        method: request.method,
        protocol,
        statusCode,
        responseSize: responsePayload.size,
        requestSize: requestPayload.size,
        userAgent: request.headers?.['user-agent'],
        ipAddress: request.ip,
      };

      // Record response time alongside the request count.
      const timeMetric = new UsageMetric();
      timeMetric.type = MetricType.RESPONSE_TIME;
      timeMetric.value = responseTime;
      timeMetric.status = metric.status;
      timeMetric.gatewayId = gatewayId;
      timeMetric.toolId = toolId;
      timeMetric.userId = userId;
      timeMetric.organizationId = organizationId;
      timeMetric.timestamp = new Date();

      // One round trip for both metrics rather than two. Neither depends on
      // the other and they land in the same table, so TypeORM batches them
      // into a single multi-row INSERT.
      this.usageMetricRepository.save([metric, timeMetric]).catch(err => {
        this.logger.warn(`Failed to save usage metrics: ${err.message}`);
      });
    } catch (err) {
      this.logger.warn(`Request logging error: ${err.message}`);
    }
  }

  /**
   * The human-readable reason a request was refused.
   *
   * `error.message` alone is not it: Nest derives an HttpException's
   * message from its payload and falls back to the class name when the
   * payload has no `message` key, so a payload like
   * `{ error, errorCode }` produced the literal string
   * "Http Exception" — which is what this column held for every refused
   * gateway request. Read the payload first and only then fall back.
   */
  private errorMessageOf(error: any): string | null {
    if (!error) return null;
    const payload =
      typeof error.getResponse === 'function' ? error.getResponse() : undefined;
    if (typeof payload === 'string' && payload.trim()) return payload;
    if (payload && typeof payload === 'object') {
      const candidate = (payload as any).message ?? (payload as any).error;
      if (Array.isArray(candidate) && candidate.length) return candidate.join('; ');
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
    const message = error.message;
    if (typeof message === 'string' && message.trim() && message !== 'Http Exception') {
      return message;
    }
    return message || null;
  }

  /** Stable refusal code, from the payload or from the exception itself. */
  private errorCodeOf(error: any): string | null {
    if (!error) return null;
    const payload =
      typeof error.getResponse === 'function' ? error.getResponse() : undefined;
    const fromPayload =
      payload && typeof payload === 'object'
        ? (payload as any).errorCode ?? (payload as any).code
        : undefined;
    const raw = fromPayload ?? error.errorCode ?? error.code;
    return typeof raw === 'string' && raw.trim() ? raw.slice(0, 64) : null;
  }

  /** The rate-limit bucket that tripped, when the refusal was a 429. */
  private rateLimitBucketOf(error: any): Record<string, any> | null {
    const payload =
      error && typeof error.getResponse === 'function' ? error.getResponse() : undefined;
    if (!payload || typeof payload !== 'object') return null;
    const bucket = (payload as any).bucket;
    return bucket && typeof bucket === 'object' ? bucket : null;
  }

  private sanitizeHeaders(headers: Record<string, any>): Record<string, any> {
    if (!headers) return {};
    const sanitized = { ...headers };
    delete sanitized.authorization;
    delete sanitized.Authorization;
    delete sanitized['x-api-key'];
    delete sanitized['X-API-Key'];
    delete sanitized.cookie;
    return sanitized;
  }

  /**
   * One serialization pass per body, yielding both things the log needs:
   * the truncated text for the `*Body` column and the byte size for the
   * `*Size` column (and for the metric metadata, which records the same
   * number). Previously `truncateBody` and `estimateSize` each did their own
   * `JSON.stringify`, and `estimateSize` was called twice per body.
   */
  private serializeOnce(data: any): { truncated: string | null; size: number } {
    if (!data) return { truncated: null, size: 0 };
    let str: string;
    try {
      str = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      return { truncated: '[unserializable]', size: 0 };
    }
    if (str === undefined || str === null || str === '') {
      return { truncated: str === '' ? '' : null, size: 0 };
    }
    const size = Buffer.byteLength(str, 'utf8');
    const truncated =
      str.length > REQUEST_LOG_BODY_LIMIT
        ? str.substring(0, REQUEST_LOG_BODY_LIMIT) + '... [truncated]'
        : str;
    return { truncated, size };
  }

  private extractToolId(path: string): string | null {
    // Match tool execution paths
    const toolMatch = path.match(/\/tools\/([0-9a-f-]{36})/);
    if (toolMatch) return toolMatch[1];
    return null;
  }

  private detectProtocol(path: string): string | null {
    // Fallback for fixed protocol routes. Slug-based paths
    // (/:orgSlug/:resourceSlug) are covered by ProtocolContext instead.
    if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';
    if (path === '/utcp' || path.startsWith('/utcp/')) return 'utcp';
    if (path === '/a2a' || path.startsWith('/a2a/')) return 'a2a';
    if (path.includes('/skills') || path.includes('/skill')) return 'skills';
    return null;
  }

  private isProtocolRequest(path: string): boolean {
    // NOTE: management calls under /gateways/* (CRUD, auth config, key
    // management) are deliberately NOT logged — they used to be, which
    // filled the analytics Request Log with the dashboard's own API calls.
    return this.detectProtocol(path) !== null ||
           path.match(/\/tools\/[^/]+\/execute/) !== null;
  }

  private extractController(path: string): string {
    const segments = path.split('/').filter(Boolean);
    return segments[0] || 'root';
  }
}
