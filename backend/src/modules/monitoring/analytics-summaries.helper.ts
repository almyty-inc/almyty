import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';

import { AuditLog } from '../../entities/audit-log.entity';
import { AgentRun } from '../../entities/agent-run.entity';

@Injectable()
export class AnalyticsSummariesHelper {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(AgentRun)
    private readonly agentRunRepository: Repository<AgentRun>,
  ) {}

  async getAuditSummary(organizationId: string) {
    if (!organizationId) {
      throw new Error('getAuditSummary requires organizationId');
    }
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [totalToday, totalWeek, totalMonth, byResourceType, byAction, topUsers, hourlyTimeline] = await Promise.all([
      this.auditLogRepository.count({ where: { organizationId, createdAt: MoreThanOrEqual(todayStart) } }).catch(() => 0),
      this.auditLogRepository.count({ where: { organizationId, createdAt: MoreThanOrEqual(weekStart) } }).catch(() => 0),
      this.auditLogRepository.count({ where: { organizationId, createdAt: MoreThanOrEqual(monthStart) } }).catch(() => 0),
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
      totals: { today: totalToday, thisWeek: totalWeek, thisMonth: totalMonth },
      byResourceType: byResourceType.map(r => ({ resourceType: r.resourceType, count: parseInt(r.count, 10) })),
      byAction: byAction.map(r => ({ action: r.action, count: parseInt(r.count, 10) })),
      topUsers: topUsers.map(r => ({ userId: r.userId, userEmail: r.userEmail, count: parseInt(r.count, 10) })),
      timeline: hourlyTimeline.map(r => ({ timestamp: r.bucket, count: parseInt(r.count, 10) })),
    };
  }

  async getAgentRunsSummary(organizationId: string) {
    if (!organizationId) {
      throw new Error('getAgentRunsSummary requires organizationId');
    }
    const now = new Date();
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [totalRuns, completedRuns, failedRuns, cancelledRuns, avgDuration, totalCost, runsByAgent, runsTimeline] = await Promise.all([
      this.agentRunRepository.count({ where: { organizationId, createdAt: MoreThanOrEqual(last7d) } }).catch(() => 0),
      this.agentRunRepository.count({ where: { organizationId, status: 'completed' as any, createdAt: MoreThanOrEqual(last7d) } }).catch(() => 0),
      this.agentRunRepository.count({ where: { organizationId, status: 'failed' as any, createdAt: MoreThanOrEqual(last7d) } }).catch(() => 0),
      this.agentRunRepository.count({ where: { organizationId, status: 'cancelled' as any, createdAt: MoreThanOrEqual(last7d) } }).catch(() => 0),
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
      totals: { total: totalRuns, completed: completedRuns, failed: failedRuns, cancelled: cancelledRuns },
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
}
