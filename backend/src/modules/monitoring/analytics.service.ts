import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric, MetricType } from '../../entities/usage-metric.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AnalyticsExportHelper } from './analytics-export.helper';
import { AnalyticsSummariesHelper } from './analytics-summaries.helper';
import { notOthersPrivateGateway, notOthersPrivateProvider } from './private-rows';

export interface RequestLogQuery {
  organizationId: string;
  page: number;
  limit: number;
  gatewayId?: string;
  /** Who is asking; other users' private gateways are left out. */
  callerId: string;
  toolId?: string;
  protocol?: string;
  statusFilter?: string;
  from?: Date;
  to?: Date;
}

export interface ExportQuery {
  organizationId: string;
  format: 'json' | 'csv';
  from?: Date;
  to?: Date;
  type: 'requests' | 'tool-executions' | 'llm-sessions';
  /** Who is exporting; other users' private gateways/providers are left out. */
  callerId: string;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(RequestLog)
    private readonly requestLogRepository: Repository<RequestLog>,
    @InjectRepository(UsageMetric)
    private readonly usageMetricRepository: Repository<UsageMetric>,
    @InjectRepository(ToolExecution)
    private readonly toolExecutionRepository: Repository<ToolExecution>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(AgentRun)
    private readonly agentRunRepository: Repository<AgentRun>,
    private readonly exportHelper: AnalyticsExportHelper,
    private readonly summaries: AnalyticsSummariesHelper,
  ) {}

  async getOverview(organizationId: string) {
    if (!organizationId) {
      throw new Error('getOverview requires organizationId');
    }

    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // RequestLog carries its own `organizationId` (added by
    // 1750796000000-RequestLogOrganization, backfilled from the gateway and
    // from the interceptor's `metadata.organizationId`, written on every
    // insert since). Scope on that column: the older
    // `(gw.organizationId = ... OR log.metadata->>'organizationId' = ...)`
    // spanned two tables, so no index could serve it and every tile scanned
    // the whole timestamp range for EVERY tenant and then hash-joined the
    // other orgs away. `IDX_request_logs_organizationId_timestamp` matches
    // (organizationId, timestamp) directly, which is what these four tiles
    // and the timeline ask for.
    //
    // RequestLog only ever holds genuine gateway/protocol/tool-execution
    // traffic: the request-logging interceptor early-returns for anything
    // that is neither a resolved-gateway request (ProtocolContext) nor a
    // protocol/tool-execute path, so internal management XHR (GET /apis,
    // GET /gateways/..., dashboard/settings calls) is never written here.
    //
    // The old `metadata->>'protocol' IS NOT NULL` guard was therefore both
    // redundant AND lossy: tool-execution logs (`.../tools/:id/execute`) are
    // logged with no protocol, so the guard silently zeroed real traffic that
    // the Request Log surface (getRequestLogs, which has no such guard) still
    // showed. Scope on org only — the same reliable gate getRequestLogs uses.
    const [
      totalRequests24h,
      totalRequests7d,
      totalToolExecs24h,
      totalToolExecs7d,
      avgResponseTime24h,
      errorCount24h,
      llmSessions24h,
      llmCost7d,
    ] = await Promise.all([
      this.requestLogRepository
        .createQueryBuilder('log')
        .where('log.organizationId = :orgId', { orgId: organizationId })
        .andWhere('log.timestamp >= :since', { since: last24h })
        .getCount()
        .catch(() => 0),
      this.requestLogRepository
        .createQueryBuilder('log')
        .where('log.organizationId = :orgId', { orgId: organizationId })
        .andWhere('log.timestamp >= :since', { since: last7d })
        .getCount()
        .catch(() => 0),
      this.toolExecutionRepository.count({
        where: { organizationId, createdAt: MoreThanOrEqual(last24h) },
      }).catch(() => 0),
      this.toolExecutionRepository.count({
        where: { organizationId, createdAt: MoreThanOrEqual(last7d) },
      }).catch(() => 0),
      this.requestLogRepository
        .createQueryBuilder('log')
        .select('AVG(log.responseTime)', 'avg')
        .where('log.organizationId = :orgId', { orgId: organizationId })
        .andWhere('log.timestamp >= :since', { since: last24h })
        .getRawOne()
        .then(r => Math.round(r?.avg || 0))
        .catch(() => 0),
      this.requestLogRepository
        .createQueryBuilder('log')
        .where('log.organizationId = :orgId', { orgId: organizationId })
        .andWhere('log.timestamp >= :since', { since: last24h })
        .andWhere('log.statusCode >= 500')
        .getCount()
        .catch(() => 0),
      this.conversationRepository.count({
        where: { organizationId, createdAt: MoreThanOrEqual(last24h) },
      }).catch(() => 0),
      this.conversationRepository
        .createQueryBuilder('session')
        .select('SUM(session.totalCost)', 'total')
        .where('session.organizationId = :orgId', { orgId: organizationId })
        .andWhere('session.createdAt >= :since', { since: last7d })
        .getRawOne()
        .then(r => parseFloat(r?.total || '0'))
        .catch(() => 0),
    ]);

    return {
      last24h: {
        requests: totalRequests24h,
        toolExecutions: totalToolExecs24h,
        avgResponseTime: avgResponseTime24h,
        errors: errorCount24h,
        llmSessions: llmSessions24h,
      },
      last7d: {
        requests: totalRequests7d,
        toolExecutions: totalToolExecs7d,
        llmCostCents: Math.round(llmCost7d * 100) / 100,
      },
    };
  }

  async getRequestLogs(query: RequestLogQuery) {
    // CRITICAL: scope every read on `log.organizationId`. The original query
    // was unscoped, so any authenticated caller could see every request log
    // in the database across every organization.
    //
    // The scope predicate is the column itself, not
    // `(gw.organizationId = ... OR log.metadata->>'organizationId' = ...)`:
    // an OR spanning two tables is unindexable, so Postgres fell back to the
    // plain timestamp index and read every tenant's logs in the window before
    // hash-joining them away. `IDX_request_logs_organizationId_timestamp`
    // covers (organizationId, timestamp) exactly.
    if (!query.organizationId) {
      throw new Error('getRequestLogs requires organizationId');
    }
    const qb = this.requestLogRepository
      .createQueryBuilder('log')
      // Project only the columns the mapper below emits. `requestBody` and
      // `responseBody` are text columns the interceptor truncates at 10,000
      // chars each, so a default 50-row page dragged up to ~1 MB of bodies
      // across the wire only for the mapper to drop them.
      .select([
        'log.id',
        'log.method',
        'log.path',
        'log.statusCode',
        'log.responseTime',
        'log.metadata',
        'log.gatewayId',
        'log.toolId',
        'log.userId',
        'log.userAgent',
        'log.ipAddress',
        'log.errorMessage',
        'log.requestSize',
        'log.responseSize',
        'log.timestamp',
      ])
      .where('log.organizationId = :orgId', { orgId: query.organizationId })
      .orderBy('log.timestamp', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);

    // Another member's private gateway: its traffic is not listed.
    qb.andWhere(`(log.gatewayId IS NULL OR ${notOthersPrivateGateway('log."gatewayId"')})`, { privateViewerId: query.callerId });
    if (query.gatewayId) {
      qb.andWhere('log.gatewayId = :gatewayId', { gatewayId: query.gatewayId });
    }
    if (query.toolId) {
      qb.andWhere('log.toolId = :toolId', { toolId: query.toolId });
    }
    if (query.protocol) {
      qb.andWhere("log.metadata->>'protocol' = :protocol", { protocol: query.protocol });
    }
    if (query.statusFilter === 'error') {
      qb.andWhere('log.statusCode >= 400');
    } else if (query.statusFilter === 'success') {
      qb.andWhere('log.statusCode < 400');
    }
    if (query.from) {
      qb.andWhere('log.timestamp >= :from', { from: query.from });
    }
    if (query.to) {
      qb.andWhere('log.timestamp <= :to', { to: query.to });
    }

    const [logs, total] = await qb.getManyAndCount();

    return {
      data: logs.map(log => ({
        id: log.id,
        method: log.method,
        path: log.path,
        statusCode: log.statusCode,
        responseTime: log.responseTime,
        protocol: (log.metadata as any)?.protocol || null,
        gatewayId: log.gatewayId,
        toolId: log.toolId,
        userId: log.userId,
        userAgent: log.userAgent,
        ipAddress: log.ipAddress,
        errorMessage: log.errorMessage,
        requestSize: log.requestSize,
        responseSize: log.responseSize,
        timestamp: log.timestamp,
      })),
      total,
      page: query.page,
      pages: Math.ceil(total / query.limit),
    };
  }

  async getToolUsage(organizationId: string, timeframe: string, callerId?: string | null) {
    if (!organizationId) {
      throw new Error('getToolUsage requires organizationId');
    }
    const since = this.getTimeframeDate(timeframe);

    const results = await this.toolExecutionRepository
      .createQueryBuilder('exec')
      .select('exec.toolId', 'toolId')
      .addSelect('COUNT(*)', 'totalExecutions')
      .addSelect('SUM(CASE WHEN exec.success = true THEN 1 ELSE 0 END)', 'successCount')
      .addSelect('AVG(exec.executionTime)', 'avgExecutionTime')
      .addSelect('MAX(exec.createdAt)', 'lastUsed')
      .where('exec.organizationId = :orgId', { orgId: organizationId })
      .andWhere('exec.createdAt >= :since', { since })
      // Another member's private tools are not in this caller's usage table.
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM tools pt WHERE pt.id = exec."toolId" AND pt.visibility = 'private' AND pt."createdBy" IS DISTINCT FROM :_privateMe)`,
        { _privateMe: callerId ?? null },
      )
      .groupBy('exec.toolId')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany();

    return results.map(r => ({
      toolId: r.toolId,
      totalExecutions: parseInt(r.totalExecutions, 10),
      successCount: parseInt(r.successCount, 10),
      successRate: r.totalExecutions > 0
        ? Math.round((parseInt(r.successCount, 10) / parseInt(r.totalExecutions, 10)) * 100)
        : 0,
      avgExecutionTime: Math.round(parseFloat(r.avgExecutionTime) || 0),
      lastUsed: r.lastUsed,
    }));
  }

  async getGatewayUsage(organizationId: string, timeframe: string, callerId: string) {
    if (!organizationId) {
      throw new Error('getGatewayUsage requires organizationId');
    }
    const since = this.getTimeframeDate(timeframe);

    // CRITICAL: previously this method took organizationId as a
    // parameter and never used it. Every authenticated user got every
    // org's per-gateway usage counts back. Scope by metric.organizationId
    // (which is indexed on (organizationId, timestamp)).
    const results = await this.usageMetricRepository
      .createQueryBuilder('metric')
      .select('metric.gatewayId', 'gatewayId')
      .addSelect('COUNT(*)', 'totalRequests')
      .addSelect("SUM(CASE WHEN metric.status = 'success' THEN 1 ELSE 0 END)", 'successCount')
      .addSelect("SUM(CASE WHEN metric.status = 'error' THEN 1 ELSE 0 END)", 'errorCount')
      .where('metric.organizationId = :orgId', { orgId: organizationId })
      .andWhere('metric.type = :type', { type: MetricType.REQUEST_COUNT })
      .andWhere('metric.gatewayId IS NOT NULL')
      .andWhere(notOthersPrivateGateway('metric."gatewayId"'), { privateViewerId: callerId })
      .andWhere('metric.timestamp >= :since', { since })
      .groupBy('metric.gatewayId')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany();

    return results.map(r => ({
      gatewayId: r.gatewayId,
      totalRequests: parseInt(r.totalRequests, 10),
      successCount: parseInt(r.successCount, 10),
      errorCount: parseInt(r.errorCount, 10),
      successRate: r.totalRequests > 0
        ? Math.round((parseInt(r.successCount, 10) / parseInt(r.totalRequests, 10)) * 100)
        : 0,
    }));
  }

  async getLlmUsage(organizationId: string, timeframe: string, callerId: string) {
    if (!organizationId) {
      throw new Error('getLlmUsage requires organizationId');
    }
    const since = this.getTimeframeDate(timeframe);

    const sessions = await this.conversationRepository
      .createQueryBuilder('session')
      .select('session.providerId', 'providerId')
      .addSelect('COUNT(*)', 'sessionCount')
      .addSelect('SUM(session.messageCount)', 'totalMessages')
      .addSelect('SUM(session.totalInputTokens)', 'totalInputTokens')
      .addSelect('SUM(session.totalOutputTokens)', 'totalOutputTokens')
      .addSelect('SUM(session.totalCost)', 'totalCostDollars')
      .addSelect('SUM(session.toolCalls)', 'totalToolCalls')
      .where('session.organizationId = :orgId', { orgId: organizationId })
      .andWhere(`(session.providerId IS NULL OR ${notOthersPrivateProvider('session."providerId"')})`, { privateViewerId: callerId })
      .andWhere('session.createdAt >= :since', { since })
      .groupBy('session.providerId')
      .getRawMany();

    return sessions.map(s => ({
      providerId: s.providerId,
      sessionCount: parseInt(s.sessionCount, 10),
      totalMessages: parseInt(s.totalMessages, 10),
      totalInputTokens: parseInt(s.totalInputTokens, 10),
      totalOutputTokens: parseInt(s.totalOutputTokens, 10),
      // Conversation.totalCost is dollars (SpendService documents the
      // same for AgentRun.totalCost and multiplies by 100 to get cents).
      // The field is named cents and the LLM analytics tab divides by
      // 100 before rendering, so cents is what it has to carry.
      totalCostCents: Math.round(parseFloat(s.totalCostDollars || '0') * 100),
      totalToolCalls: parseInt(s.totalToolCalls, 10),
    }));
  }

  async getTimeline(organizationId: string, timeframe: string, granularity: string) {
    if (!organizationId) {
      throw new Error('getTimeline requires organizationId');
    }
    const since = this.getTimeframeDate(timeframe);
    const truncInterval = granularity === 'minute' ? 'minute' :
                          granularity === 'hour' ? 'hour' :
                          granularity === 'day' ? 'day' : 'hour';

    const results = await this.requestLogRepository
      .createQueryBuilder('log')
      .select(`date_trunc('${truncInterval}', log.timestamp)`, 'bucket')
      .addSelect('COUNT(*)', 'requests')
      .addSelect('SUM(CASE WHEN log.statusCode >= 400 THEN 1 ELSE 0 END)', 'errors')
      .addSelect('AVG(log.responseTime)', 'avgResponseTime')
      .where('log.organizationId = :orgId', { orgId: organizationId })
      .andWhere('log.timestamp >= :since', { since })
      .groupBy('bucket')
      .orderBy('bucket', 'ASC')
      .getRawMany();

    return results.map(r => ({
      timestamp: r.bucket,
      requests: parseInt(r.requests, 10),
      errors: parseInt(r.errors, 10),
      avgResponseTime: Math.round(parseFloat(r.avgResponseTime) || 0),
    }));
  }

  getAuditSummary(...args: Parameters<AnalyticsSummariesHelper['getAuditSummary']>) {
    return this.summaries.getAuditSummary(...args);
  }

  getAgentRunsSummary(...args: Parameters<AnalyticsSummariesHelper['getAgentRunsSummary']>) {
    return this.summaries.getAgentRunsSummary(...args);
  }


  exportData(...args: Parameters<AnalyticsExportHelper['exportData']>) {
    return this.exportHelper.exportData(...args);
  }

  private getTimeframeDate(timeframe: string): Date {
    const now = new Date();
    const match = timeframe.match(/^(\d+)(h|d|w|m)$/);
    if (!match) return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 'h': return new Date(now.getTime() - value * 60 * 60 * 1000);
      case 'd': return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
      case 'w': return new Date(now.getTime() - value * 7 * 24 * 60 * 60 * 1000);
      case 'm': return new Date(now.getTime() - value * 30 * 24 * 60 * 60 * 1000);
      default: return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
  }
}
