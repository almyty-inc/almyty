import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric, MetricType } from '../../entities/usage-metric.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { LlmSession } from '../../entities/llm-session.entity';
import { LlmMessage } from '../../entities/llm-message.entity';

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
  ) {}

  async getOverview(organizationId: string) {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

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
        .where('log.timestamp >= :since', { since: last24h })
        .andWhere("log.metadata->>'protocol' IS NOT NULL")
        .getCount()
        .catch(() => 0),
      this.requestLogRepository
        .createQueryBuilder('log')
        .where('log.timestamp >= :since', { since: last7d })
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
        .select('AVG(log.responseTime)', 'avg')
        .where('log.timestamp >= :since', { since: last24h })
        .andWhere("log.metadata->>'protocol' IS NOT NULL")
        .getRawOne()
        .then(r => Math.round(r?.avg || 0))
        .catch(() => 0),
      this.requestLogRepository
        .createQueryBuilder('log')
        .where('log.timestamp >= :since', { since: last24h })
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
    const qb = this.requestLogRepository
      .createQueryBuilder('log')
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
    const since = this.getTimeframeDate(timeframe);

    const results = await this.usageMetricRepository
      .createQueryBuilder('metric')
      .select('metric.gatewayId', 'gatewayId')
      .addSelect('COUNT(*)', 'totalRequests')
      .addSelect("SUM(CASE WHEN metric.status = 'success' THEN 1 ELSE 0 END)", 'successCount')
      .addSelect("SUM(CASE WHEN metric.status = 'error' THEN 1 ELSE 0 END)", 'errorCount')
      .where('metric.type = :type', { type: MetricType.REQUEST_COUNT })
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
      .where('log.timestamp >= :since', { since })
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

  async exportData(query: ExportQuery): Promise<any> {
    const from = query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to || new Date();

    if (query.type === 'requests') {
      const logs = await this.requestLogRepository.find({
        where: { timestamp: Between(from, to) },
        order: { timestamp: 'DESC' },
        take: 10000,
      });

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
      columns.map(col => {
        const val = item[col];
        if (val === null || val === undefined) return '';
        const str = String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      }).join(','),
    );
    return [header, ...rows].join('\n');
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
