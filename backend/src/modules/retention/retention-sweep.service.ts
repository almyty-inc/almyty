import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository, FindOptionsWhere } from 'typeorm';
import { RetentionPolicy } from '../../entities/retention-policy.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { AuditLog, AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { Gateway } from '../../entities/gateway.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { NotificationsService } from '../notifications/notifications.service';

const SWEEP_INTERVAL_MS =
  Number(process.env.RETENTION_SWEEP_INTERVAL_MS) || 60 * 60_000; // hourly
const SWEEP_BATCH = 1000;
// Bound the work of a single sweep per data class; anything left over is
// picked up by the next interval.
const MAX_BATCHES_PER_CLASS = 50;

/**
 * Only runs in a terminal state are ever deleted. PENDING, RUNNING,
 * WAITING_INPUT, SLEEPING and WAITING_APPROVAL rows are left alone no
 * matter how old they are — they are still live workflow state.
 */
const TERMINAL_RUN_STATUSES = [
  AgentRunStatus.COMPLETED,
  AgentRunStatus.FAILED,
  AgentRunStatus.CANCELLED,
  AgentRunStatus.TIMEOUT,
];

export interface SweepCounts {
  agentRuns: number;
  conversations: number;
  messages: number;
  requestLogs: number;
  usageMetrics: number;
  auditLogs: number;
}

/**
 * Periodic in-process retention sweep (mirrors AgentRunReaperService /
 * the referral qualification sweep). For every org with an enabled
 * retention policy it batch-deletes rows older than the configured
 * cutoff, one data class at a time. NULL day-counts mean "keep forever"
 * and are skipped, so orgs without a policy — or with an all-NULL one —
 * are never touched.
 *
 * FK notes (verified against InitialSchema):
 * - messages -> conversations is ON DELETE CASCADE at the DB level, but
 *   we delete messages explicitly first so the reported counts are exact
 *   and we never depend on the cascade being present.
 * - agent_runs.conversationId and conversations.parentConversationId are
 *   ON DELETE SET NULL — deleting conversations detaches, not deletes.
 * - Nothing references agent_runs with a DB-level FK (approval_requests
 *   .runId is a soft reference), so run deletion needs no child pass.
 * - request_logs has no organizationId; rows are scoped through the
 *   org's gateways. Logs with a NULL gatewayId are unattributable and
 *   are left alone.
 */
@Injectable()
export class RetentionSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionSweepService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(RetentionPolicy)
    private readonly policyRepository: Repository<RetentionPolicy>,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(RequestLog)
    private readonly requestLogRepository: Repository<RequestLog>,
    @InjectRepository(UsageMetric)
    private readonly usageMetricRepository: Repository<UsageMetric>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    private readonly auditLogService: AuditLogService,
    // @Global notifications pipeline; @Optional() keeps existing unit
    // tests (constructed without it) working.
    @Optional()
    private readonly notifications?: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        this.logger.warn(`Retention sweep failed: ${err.message}`);
      });
    }, SWEEP_INTERVAL_MS);
    // Don't keep the event loop alive for the timer (matches the other
    // runtime sweeps).
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one full sweep across all orgs with an enabled policy. */
  async sweep(): Promise<Map<string, SweepCounts>> {
    const results = new Map<string, SweepCounts>();
    const policies = await this.policyRepository.find();
    for (const policy of policies) {
      if (policy.enabled === false) continue;
      try {
        const counts = await this.sweepOrganization(policy);
        results.set(policy.organizationId, counts);
      } catch (err) {
        this.logger.warn(
          `Retention sweep failed for org ${policy.organizationId}: ${err.message}`,
        );
      }
    }
    return results;
  }

  /** Sweep a single org according to its policy. Returns per-class counts. */
  async sweepOrganization(policy: RetentionPolicy): Promise<SweepCounts> {
    const organizationId = policy.organizationId;
    const counts: SweepCounts = {
      agentRuns: 0,
      conversations: 0,
      messages: 0,
      requestLogs: 0,
      usageMetrics: 0,
      auditLogs: 0,
    };

    if (policy.agentRunsDays != null) {
      counts.agentRuns = await this.batchDelete(this.runRepository, {
        organizationId,
        status: In(TERMINAL_RUN_STATUSES),
        createdAt: LessThan(this.cutoff(policy.agentRunsDays)),
      } as FindOptionsWhere<AgentRun>);
    }

    if (policy.conversationsDays != null) {
      const swept = await this.sweepConversations(
        organizationId,
        this.cutoff(policy.conversationsDays),
      );
      counts.conversations = swept.conversations;
      counts.messages = swept.messages;
    }

    if (policy.requestLogsDays != null) {
      counts.requestLogs = await this.sweepRequestLogs(
        organizationId,
        this.cutoff(policy.requestLogsDays),
      );
    }

    if (policy.usageMetricsDays != null) {
      counts.usageMetrics = await this.batchDelete(this.usageMetricRepository, {
        organizationId,
        timestamp: LessThan(this.cutoff(policy.usageMetricsDays)),
      } as FindOptionsWhere<UsageMetric>);
    }

    if (policy.auditLogDays != null) {
      counts.auditLogs = await this.batchDelete(this.auditLogRepository, {
        organizationId,
        createdAt: LessThan(this.cutoff(policy.auditLogDays)),
      } as FindOptionsWhere<AuditLog>);
    }

    const total =
      counts.agentRuns +
      counts.conversations +
      counts.messages +
      counts.requestLogs +
      counts.usageMetrics +
      counts.auditLogs;

    if (total > 0) {
      this.logger.log(
        `Retention sweep for org ${organizationId}: deleted ` +
          `${counts.agentRuns} run(s), ${counts.conversations} conversation(s), ` +
          `${counts.messages} message(s), ${counts.requestLogs} request log(s), ` +
          `${counts.usageMetrics} usage metric(s), ${counts.auditLogs} audit log(s)`,
      );
      // Deleting records is itself a sensitive action — leave a trace.
      await this.auditLogService.log({
        organizationId,
        action: AuditAction.RETENTION_SWEEP,
        resourceType: AuditResource.ORGANIZATION,
        resourceId: organizationId,
        resourceName: 'retention_sweep',
        details: { ...counts },
      });

      // Best-effort admin notification, max one per org per day.
      await this.notifySweep(organizationId, counts, total);
    }

    return counts;
  }

  private cutoff(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  /**
   * Delete rows matching `where` in id-batches of SWEEP_BATCH. Selecting
   * ids first keeps each DELETE bounded (Postgres has no DELETE ... LIMIT).
   */
  private async batchDelete<T extends { id: string }>(
    repository: Repository<T>,
    where: FindOptionsWhere<T>,
  ): Promise<number> {
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_CLASS; batch++) {
      const rows = await repository.find({
        where,
        select: ['id'] as any,
        take: SWEEP_BATCH,
      });
      if (rows.length === 0) break;
      const result = await repository.delete({
        id: In(rows.map((r) => r.id)),
      } as any);
      deleted += result.affected ?? rows.length;
      if (rows.length < SWEEP_BATCH) break;
    }
    return deleted;
  }

  /**
   * Conversations: delete the messages of each expired conversation first
   * (exact counts, no reliance on the DB cascade), then the conversations
   * themselves. agent_runs.conversationId is ON DELETE SET NULL, so runs
   * survive their conversation.
   */
  private async sweepConversations(
    organizationId: string,
    cutoff: Date,
  ): Promise<{ conversations: number; messages: number }> {
    let conversations = 0;
    let messages = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_CLASS; batch++) {
      const rows = await this.conversationRepository.find({
        where: { organizationId, createdAt: LessThan(cutoff) },
        select: ['id'],
        take: SWEEP_BATCH,
      });
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id);
      const messageResult = await this.messageRepository.delete({
        conversationId: In(ids),
      });
      messages += messageResult.affected ?? 0;
      const conversationResult = await this.conversationRepository.delete({
        id: In(ids),
      });
      conversations += conversationResult.affected ?? ids.length;
      if (rows.length < SWEEP_BATCH) break;
    }
    return { conversations, messages };
  }

  /**
   * request_logs has no organizationId column; scope through the org's
   * gateways. Rows with a NULL gatewayId cannot be attributed to an org
   * and are intentionally left alone.
   */
  private async sweepRequestLogs(
    organizationId: string,
    cutoff: Date,
  ): Promise<number> {
    const gateways = await this.gatewayRepository.find({
      where: { organizationId },
      select: ['id'],
    });
    if (gateways.length === 0) return 0;
    return this.batchDelete(this.requestLogRepository, {
      gatewayId: In(gateways.map((g) => g.id)),
      timestamp: LessThan(cutoff),
    } as FindOptionsWhere<RequestLog>);
  }

  /**
   * retention.sweep — tell the org's admins their retention policy
   * deleted data. Only when something was actually deleted, and at
   * most once per org per day (checked against the latest stored
   * notification, so it survives restarts and multiple replicas).
   */
  private async notifySweep(organizationId: string, counts: SweepCounts, total: number): Promise<void> {
    if (!this.notifications || total <= 0) return;
    try {
      const recent = await this.notifications.hasRecentOrgNotification(
        organizationId,
        'retention.sweep',
        24 * 60 * 60 * 1000,
      );
      if (recent) return;

      const summary =
        `${counts.agentRuns} runs, ${counts.conversations} conversations, ` +
        `${counts.messages} messages, ${counts.requestLogs} request logs, ` +
        `${counts.usageMetrics} usage metrics, ${counts.auditLogs} audit logs`;
      await this.notifications.emit({
        type: 'retention.sweep',
        organizationId,
        roleTarget: { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
        title: 'Retention sweep completed',
        body: `Your retention policy deleted ${total} expired records (${summary}).`,
        link: '/settings',
        email: {
          template: 'retention.sweep',
          params: { totalDeleted: total, summary },
        },
      });
    } catch (err: any) {
      this.logger.warn(`retention sweep notification failed: ${err?.message ?? err}`);
    }
  }
}
