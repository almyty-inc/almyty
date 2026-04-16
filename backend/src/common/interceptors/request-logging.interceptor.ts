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

    // Skip health checks and static assets
    const path = request.path || request.url;
    if (this.shouldSkip(path)) {
      return next.handle();
    }

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

  private shouldSkip(path: string): boolean {
    // Only log protocol/gateway requests and tool executions — NOT internal management API calls.
    // Internal calls (GET /apis, GET /tools, GET /analytics, etc.) are the frontend
    // talking to itself and would pollute analytics with noise.
    const isProtocolRequest = this.isProtocolRequest(path);
    if (isProtocolRequest) return false; // Always log protocol requests

    // Skip everything else — internal management API, health, docs, etc.
    return true;
  }

  private async logRequest(
    request: any,
    response: any,
    startTime: number,
    responseBody: any,
    error: any,
  ): Promise<void> {
    try {
      const responseTime = Date.now() - startTime;
      const statusCode = error?.status || error?.getStatus?.() || response.statusCode || 500;
      const path = request.path || request.url;

      // Extract gateway and tool context from the request
      const gatewayId = request.params?.gatewayId || this.extractGatewayId(path);
      const toolId = request.params?.toolId || this.extractToolId(path, request.body);
      const userId = request.user?.id || null;
      const organizationId = request.user?.currentOrganizationId || null;

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
        protocol: this.detectProtocol(path),
        organizationId,
        controller: this.extractController(path),
      };

      // Save async — don't block the response
      this.requestLogRepository.save(log).catch(err => {
        this.logger.warn(`Failed to save request log: ${err.message}`);
      });

      // Also record usage metric for gateway/tool requests
      if (gatewayId || toolId || this.isProtocolRequest(path)) {
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
      }
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

  private extractGatewayId(path: string): string | null {
    // Match gateway protocol paths: /gateways/:endpoint, /:org/:gateway, etc.
    const gatewayMatch = path.match(/\/gateways\/([^/]+)/);
    if (gatewayMatch) return null; // Endpoint, not ID — let the controller resolve it
    return null;
  }

  private extractToolId(path: string, body: any): string | null {
    // Match tool execution paths
    const toolMatch = path.match(/\/tools\/([0-9a-f-]{36})/);
    if (toolMatch) return toolMatch[1];
    // MCP tool_call in body
    if (body?.method === 'tools/call' && body?.params?.name) return null;
    return null;
  }

  private detectProtocol(path: string): string | null {
    if (path.startsWith('/mcp/') || path.includes('/mcp')) return 'mcp';
    if (path.startsWith('/utcp/') || path.includes('/utcp')) return 'utcp';
    if (path.startsWith('/a2a/') || path.includes('/a2a')) return 'a2a';
    if (path.includes('/skills') || path.includes('/skill')) return 'skills';
    return null;
  }

  private isProtocolRequest(path: string): boolean {
    return this.detectProtocol(path) !== null ||
           path.startsWith('/gateways/') ||
           path.match(/\/tools\/[^/]+\/execute/) !== null;
  }

  private extractController(path: string): string {
    const segments = path.split('/').filter(Boolean);
    return segments[0] || 'root';
  }
}
