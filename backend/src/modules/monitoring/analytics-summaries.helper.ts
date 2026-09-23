import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/audit-log.entity';
import { AgentRun } from '../../entities/agent-run.entity';

/** Runs of agents that are private to somebody other than :_privateMe. */
const NOT_OTHERS_PRIVATE_AGENT_RUN =
  `NOT EXISTS (SELECT 1 FROM agents pa WHERE pa.id = run."agentId" AND pa.visibility = 'private' AND pa."createdBy" IS DISTINCT FROM :_privateMe)`;

/**
 * A fallback that remembers it was used.
 *
 * Every branch of these summaries had its own `.catch(() => 0)` /
 * `.catch(() => [])`, so a database problem rendered "0 events today /
 * this week / this month" -- indistinguishable from a genuinely quiet
 * organization, on a compliance surface where that distinction is the
 * whole point. The catches stay, so one bad query does not take the
 * panel down; what changes is that the answer now says it is partial.
 */
function recorded<T>(failures: string[], name: string, fallback: T) {
  return (err: unknown): T => {
    failures.push(name);
    return fallback;
  };
}

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

    const failures: string[] = [];
    const [totals, byResourceType, byAction, topUsers, hourlyTimeline] = await Promise.all([
      // One scan of the widest window with conditional sums, instead of
      // three COUNTs over the same table differing only in their lower
      // bound. `thisMonth` is the widest, so COUNT(*) under that predicate
      // is exactly what the third COUNT used to answer.
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('SUM(CASE WHEN audit.createdAt >= :todayStart THEN 1 ELSE 0 END)', 'today')
        .addSelect('SUM(CASE WHEN audit.createdAt >= :weekStart THEN 1 ELSE 0 END)', 'thisWeek')
        .addSelect('COUNT(*)', 'thisMonth')
        .where('audit.organizationId = :orgId', { orgId: organizationId })
        .andWhere('audit.createdAt >= :monthStart', { monthStart })
        .setParameters({ todayStart, weekStart })
        .getRawOne()
        .then((r) => ({
          today: parseInt(r?.today ?? '0', 10) || 0,
          thisWeek: parseInt(r?.thisWeek ?? '0', 10) || 0,
          thisMonth: parseInt(r?.thisMonth ?? '0', 10) || 0,
        }))
        .catch(() => {
          // Keep naming each figure the caller asked about, so the surface
          // still says which numbers it could not read.
          failures.push('today', 'thisWeek', 'thisMonth');
          return { today: 0, thisWeek: 0, thisMonth: 0 };
        }),
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.resourceType', 'resourceType')
        .addSelect('COUNT(*)', 'count')
        .where('audit.organizationId = :orgId', { orgId: organizationId })
        .andWhere('audit.createdAt >= :since', { since: monthStart })
        .groupBy('audit.resourceType')
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany()
        .catch(recorded(failures, 'byResourceType', [])),
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select('audit.action', 'action')
        .addSelect('COUNT(*)', 'count')
        .where('audit.organizationId = :orgId', { orgId: organizationId })
        .andWhere('audit.createdAt >= :since', { since: monthStart })
        .groupBy('audit.action')
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany()
        .catch(recorded(failures, 'byAction', [])),
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
        .catch(recorded(failures, 'topUsers', [])),
      this.auditLogRepository
        .createQueryBuilder('audit')
        .select("date_trunc('hour', audit.createdAt)", 'bucket')
        .addSelect('COUNT(*)', 'count')
        .where('audit.organizationId = :orgId', { orgId: organizationId })
        .andWhere('audit.createdAt >= :since', { since: last24h })
        .groupBy('bucket')
        .orderBy('bucket', 'ASC')
        .getRawMany()
        .catch(recorded(failures, 'timeline', [])),
    ]);

    return {
      // Present and true when at least one figure below could not be
      // read, so the surface can say so rather than print a zero.
      partial: failures.length > 0,
      unavailable: failures,
      totals,
      byResourceType: byResourceType.map(r => ({ resourceType: r.resourceType, count: parseInt(r.count, 10) })),
      byAction: byAction.map(r => ({ action: r.action, count: parseInt(r.count, 10) })),
      topUsers: topUsers.map(r => ({ userId: r.userId, userEmail: r.userEmail, count: parseInt(r.count, 10) })),
      timeline: hourlyTimeline.map(r => ({ timestamp: r.bucket, count: parseInt(r.count, 10) })),
    };
  }

  // Runs of another member's private agent are not in this caller's
  // summary: their ids, counts and cost would describe a resource the
  // caller is not allowed to know exists.
  async getAgentRunsSummary(organizationId: string, callerId?: string | null) {
    if (!organizationId) {
      throw new Error('getAgentRunsSummary requires organizationId');
    }
    const now = new Date();
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [runTotals, avgDuration, totalCost, runsByAgent, runsTimeline] = await Promise.all([
      // One GROUP BY status instead of four COUNTs over the identical
      // window. `total` is the sum of the groups, which is what the
      // unfiltered COUNT answered.
      this.agentRunRepository
        .createQueryBuilder('run')
        .select('run.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('run.organizationId = :orgId', { orgId: organizationId })
        .andWhere(NOT_OTHERS_PRIVATE_AGENT_RUN, { _privateMe: callerId ?? null })
        .andWhere('run.createdAt >= :since', { since: last7d })
        .groupBy('run.status')
        .getRawMany()
        .then((rows) => {
          const byStatus = new Map<string, number>(
            rows.map((r) => [r.status, parseInt(r.count, 10) || 0]),
          );
          let total = 0;
          for (const n of byStatus.values()) total += n;
          return {
            total,
            completed: byStatus.get('completed') ?? 0,
            failed: byStatus.get('failed') ?? 0,
            cancelled: byStatus.get('cancelled') ?? 0,
          };
        })
        .catch(() => ({ total: 0, completed: 0, failed: 0, cancelled: 0 })),
      this.agentRunRepository
        .createQueryBuilder('run')
        .select('AVG(run.executionTime)', 'avg')
        .where('run.organizationId = :orgId', { orgId: organizationId })
        .andWhere(NOT_OTHERS_PRIVATE_AGENT_RUN, { _privateMe: callerId ?? null })
        .andWhere('run.createdAt >= :since', { since: last7d })
        .andWhere('run.executionTime > 0')
        .getRawOne()
        .then(r => Math.round(parseFloat(r?.avg || '0')))
        .catch(() => 0),
      this.agentRunRepository
        .createQueryBuilder('run')
        .select('SUM(run.totalCost)', 'total')
        .where('run.organizationId = :orgId', { orgId: organizationId })
        .andWhere(NOT_OTHERS_PRIVATE_AGENT_RUN, { _privateMe: callerId ?? null })
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
        .andWhere(NOT_OTHERS_PRIVATE_AGENT_RUN, { _privateMe: callerId ?? null })
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
        .andWhere(NOT_OTHERS_PRIVATE_AGENT_RUN, { _privateMe: callerId ?? null })
        .andWhere('run.createdAt >= :since', { since: last7d })
        .groupBy('bucket')
        .orderBy('bucket', 'ASC')
        .getRawMany()
        .catch(() => []),
    ]);

    return {
      totals: runTotals,
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
