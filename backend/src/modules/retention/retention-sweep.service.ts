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
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Notification } from '../../entities/notification.entity';
import { AuditLog, AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AgentApp, appPrivacyFrom } from '../../entities/agent-app.entity';
import { AppDistribution } from '../../entities/agent-app-distribution.entity';

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
 * How long an entity-version snapshot is kept.
 *
 * `version` carries no organizationId, so it cannot be a retention-policy
 * class; this is a deployment-wide floor under it. Long enough that the
 * Change History panel still has something to show.
 */
const VERSION_RETENTION_DAYS = 90;
const VERSION_SWEEP_BATCH = 5_000;
const VERSION_SWEEP_MAX_PASSES = 20;

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
  toolExecutions: number;
  notifications: number;
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
 *   Both referencing columns are indexed, so the SET NULL a batch of
 *   1000 deletes triggers is an index lookup and not a table scan.
 * - Nothing references agent_runs with a DB-level FK (approval_requests
 *   .runId is a soft reference), so run deletion needs no child pass.
 * - request_logs carries its own organizationId, so it is swept by that
 *   column directly. gatewayId is ON DELETE SET NULL, so scoping
 *   through the org's gateways would lose every log of a deleted one.
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
    @Optional()
    @InjectRepository(ToolExecution)
    private readonly toolExecutionRepository: Repository<ToolExecution>,
    @Optional()
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    private readonly auditLogService: AuditLogService,
    // @Global notifications pipeline; @Optional() keeps existing unit
    // tests (constructed without it) working.
    @Optional()
    private readonly notifications?: NotificationsService,
    @Optional()
    @InjectRepository(AgentApp)
    private readonly appRepository?: Repository<AgentApp>,
    @Optional()
    @InjectRepository(AppDistribution)
    private readonly distributionRepository?: Repository<AppDistribution>,

  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      // Both sweeps on the same tick: the per-org one, and the global
      // version prune the per-org one cannot express.
      Promise.all([this.sweep(), this.sweepEntityVersions()]).catch((err) => {
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

  /**
   * Prune entity-version snapshots past a global age.
   *
   * `version` is the one table the per-organization sweep structurally
   * cannot reach: it has no organizationId column, so there is nothing
   * to scope a policy to. It is also one of the fastest-growing, because
   * the version subscriber writes a full serialized entity on every
   * update of a @VersionedEntity — and the model reconcile loop saves
   * several of those every two minutes per deployment, whether anything
   * changed or not. Ten deployments running for a year is millions of
   * rows of whole-entity JSON that nothing ever deleted.
   *
   * Age-based and deployment-wide, because that is the only axis this
   * table offers. Batched so one pass cannot lock the table.
   */
  async sweepEntityVersions(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - VERSION_RETENTION_DAYS * 86_400_000);
    let deleted = 0;

    for (let pass = 0; pass < VERSION_SWEEP_MAX_PASSES; pass++) {
      const result = await this.policyRepository.query(
        `DELETE FROM "version"
          WHERE "id" IN (
            SELECT "id" FROM "version" WHERE "timestamp" < $1 LIMIT $2
          )`,
        [cutoff, VERSION_SWEEP_BATCH],
      );
      const affected = Array.isArray(result) ? result.length : (result?.[1] ?? 0);
      deleted += affected;
      if (affected < VERSION_SWEEP_BATCH) break;
    }

    if (deleted > 0) {
      this.logger.log(`Pruned ${deleted} entity-version snapshot(s) older than ${VERSION_RETENTION_DAYS}d`);
    }
    return deleted;
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
      toolExecutions: 0,
      notifications: 0,
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

    // Products may keep their visitors' conversations for less time than
    // the organization does. Never more: an app setting shortens the
    // policy, it cannot extend it.
    const perApp = await this.sweepApps(policy.organizationId, policy.conversationsDays ?? null);
    counts.conversations += perApp.conversations;
    counts.messages += perApp.messages;
    counts.agentRuns += perApp.runs;


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

    // tool_executions had no sweep at all while every sibling table had
    // one, and it is the table that grows fastest in bytes per row.
    if (policy.toolExecutionsDays != null && this.toolExecutionRepository) {
      counts.toolExecutions = await this.batchDelete(this.toolExecutionRepository, {
        organizationId,
        createdAt: LessThan(this.cutoff(policy.toolExecutionsDays)),
      } as FindOptionsWhere<ToolExecution>);
    }

    // notifications is the other per-event table nothing swept. A
    // permanently broken 5-minute schedule writes 288 rows a day
    // forever, and rows outlive any reason to read them.
    if (policy.notificationsDays != null && this.notificationRepository) {
      counts.notifications = await this.batchDelete(this.notificationRepository, {
        organizationId,
        createdAt: LessThan(this.cutoff(policy.notificationsDays)),
      } as FindOptionsWhere<Notification>);
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
  /**
   * Per-app retention for hosted-chat and widget visitors.
   *
   * Scoped through the app's published gateways, the way request logs
   * are. Runs have no gateway column, so they go through the
   * conversations being removed; agent_runs.conversationId is SET NULL,
   * so they are deleted first or they would outlive their transcript.
   */
  async sweepApps(
    organizationId: string,
    orgConversationDays: number | null,
  ): Promise<{ conversations: number; messages: number; runs: number }> {
    const out = { conversations: 0, messages: 0, runs: 0 };
    if (!this.appRepository || !this.distributionRepository) return out;
    const apps = await this.appRepository.find({ where: { organizationId } });
    for (const app of apps) {
      const appDays = appPrivacyFrom(app.privacy).retentionDays;
      if (appDays == null) continue;
      const effectiveDays = orgConversationDays == null ? appDays : Math.min(appDays, orgConversationDays);
      const distributions = await this.distributionRepository.find({ where: { appId: app.id }, select: { gatewayId: true } });
      const gatewayIds = distributions.map((d) => d.gatewayId).filter((id): id is string => !!id);
      if (gatewayIds.length === 0) continue;
      const cutoff = this.cutoff(effectiveDays);
      for (let batch = 0; batch < MAX_BATCHES_PER_CLASS; batch++) {
        const rows = await this.conversationRepository.find({
          where: { organizationId, gatewayId: In(gatewayIds), createdAt: LessThan(cutoff) },
          select: { id: true },
          take: SWEEP_BATCH,
        });
        if (rows.length === 0) break;
        const ids = rows.map((r) => r.id);
        const runs = await this.runRepository.delete({ conversationId: In(ids), status: In(TERMINAL_RUN_STATUSES) });
        out.runs += runs.affected ?? 0;
        const messages = await this.messageRepository.delete({ conversationId: In(ids) });
        out.messages += messages.affected ?? 0;
        const conversations = await this.conversationRepository.delete({ id: In(ids) });
        out.conversations += conversations.affected ?? ids.length;
        if (rows.length < SWEEP_BATCH) break;
      }
    }
    return out;
  }

  private async sweepConversations(
    organizationId: string,
    cutoff: Date,
  ): Promise<{ conversations: number; messages: number }> {
    let conversations = 0;
    let messages = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_CLASS; batch++) {
      const rows = await this.conversationRepository.find({
        where: { organizationId, createdAt: LessThan(cutoff) },
        select: { id: true },
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
   * request_logs carries its own organizationId, so the sweep does not
   * have to go through the org's gateways to find its rows. That matters
   * because gatewayId is ON DELETE SET NULL: scoping through gateways
   * meant a deleted gateway put its logs out of every policy's reach.
   */
  private async sweepRequestLogs(
    organizationId: string,
    cutoff: Date,
  ): Promise<number> {
    return this.batchDelete(this.requestLogRepository, {
      organizationId,
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
