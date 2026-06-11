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

      // Attribution: prefer the context set by the handler that resolved the
      // gateway — the URL alone can't identify gateway or protocol for
      // multi-tenant paths like /acme/petstore-mcp.
      const gatewayId = protocolContext?.gatewayId || request.params?.gatewayId || null;
      const toolId = request.params?.toolId || this.extractToolId(path) || null;
      const userId = request.user?.id || null;
      const organizationId =
        request.user?.currentOrganizationId || protocolContext?.organizationId || null;
      const protocol = protocolContext?.protocol || this.detectProtocol(path);

      // Create request log
      const log = new RequestLog();
      log.method = request.method;
      log.path = path;
      log.userAgent = request.headers?.['user-agent'] || null;
      log.ipAddress = request.ip || request.connection?.remoteAddress || null;
      log.statusCode = statusCode;
      log.responseTime = responseTime;
      log.gatewayId = gatewayId;
      log.toolId = toolId;
      log.userId = userId;
      log.requestHeaders = this.sanitizeHeaders(request.headers);
      log.requestBody = this.truncateBody(request.body);
      log.responseBody = this.truncateBody(responseBody);
      log.errorMessage = error?.message || null;
      log.requestId = request.headers?.['x-request-id'] || null;
      log.requestSize = this.estimateSize(request.body);
      log.responseSize = this.estimateSize(responseBody);
      log.timestamp = new Date();
      log.metadata = {
        protocol,
        organizationId,
        controller: this.extractController(path),
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
        responseSize: this.estimateSize(responseBody),
        requestSize: this.estimateSize(request.body),
        userAgent: request.headers?.['user-agent'],
        ipAddress: request.ip,
      };

      this.usageMetricRepository.save(metric).catch(err => {
        this.logger.warn(`Failed to save usage metric: ${err.message}`);
      });

      // Record response time metric separately
      const timeMetric = new UsageMetric();
      timeMetric.type = MetricType.RESPONSE_TIME;
      timeMetric.value = responseTime;
      timeMetric.status = metric.status;
      timeMetric.gatewayId = gatewayId;
      timeMetric.toolId = toolId;
      timeMetric.userId = userId;
      timeMetric.organizationId = organizationId;
      timeMetric.timestamp = new Date();

      this.usageMetricRepository.save(timeMetric).catch(err => {
        this.logger.warn(`Failed to save response time metric: ${err.message}`);
      });
    } catch (err) {
      this.logger.warn(`Request logging error: ${err.message}`);
    }
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

  private truncateBody(body: any): string | null {
    if (!body) return null;
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    if (str.length > 10000) return str.substring(0, 10000) + '... [truncated]';
    return str;
  }

  private estimateSize(data: any): number {
    if (!data) return 0;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return Buffer.byteLength(str, 'utf8');
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
