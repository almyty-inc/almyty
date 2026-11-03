import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

export type AgentAuditAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'activated'
  | 'deactivated'
  | 'invoked'
  | 'scheduled'
  | 'version_saved'
  | 'rolled_back'
  | 'duplicated'
  | 'exported'
  | 'imported';

export interface AgentAuditEntry {
  action: AgentAuditAction;
  userId: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface AgentAuditEvent {
  agentId: string;
  organizationId: string;
  userId: string;
  action: AgentAuditAction;
  details?: Record<string, unknown>;
}

const MAX_AUDIT_ENTRIES = 100;

/** Each agent event as the organization's audit trail records it. */
const TRAIL_ACTION: Record<AgentAuditAction, AuditAction> = {
  created: AuditAction.CREATE,
  updated: AuditAction.UPDATE,
  deleted: AuditAction.DELETE,
  activated: AuditAction.ACTIVATE,
  deactivated: AuditAction.DEACTIVATE,
  invoked: AuditAction.INVOKE,
  scheduled: AuditAction.SCHEDULE,
  version_saved: AuditAction.UPDATE,
  rolled_back: AuditAction.ROLLBACK,
  duplicated: AuditAction.DUPLICATE,
  exported: AuditAction.EXPORT,
  imported: AuditAction.IMPORT,
};

@Injectable()
export class AgentAuditService {
  private readonly logger = new Logger(AgentAuditService.name);

  constructor(
    @InjectRepository(Agent)
    private agentRepository: Repository<Agent>,
    // The organization's audit trail (and its SIEM streams). Agent edits
    // were only kept in the agent's own metadata, so Settings > Audit and
    // every streaming target missed them. @Optional for unit wiring.
    @Optional()
    private readonly auditLogService?: AuditLogService,
  ) {}

  /**
   * Append an audit log entry to the agent's metadata.auditLog array.
   * Keeps the last MAX_AUDIT_ENTRIES entries (append-only, capped).
   * The same event is written to the organization's audit trail, which
   * a deleted agent (no row left to append to) still reaches.
   *
   * Concurrency: two overlapping calls for the same agent used to
   * race — both callers read the same current log, both pushed their
   * own entry, both wrote back, and one append was silently lost.
   * With audit logs that's not just annoying, it can leave gaps in
   * the compliance trail at exactly the moments the agent is busiest.
   *
   * Fix: wrap the read/append/write in a transaction with a
   * pessimistic row lock (SELECT … FOR UPDATE on the agent row). Any
   * second caller blocks until the first's UPDATE commits, then
   * reads the post-append state and correctly appends on top of it.
   * The lock is held for one row and for the duration of a single
   * metadata update, so contention is negligible in practice.
   */
  async log(event: AgentAuditEvent): Promise<void> {
    let agentName: string | undefined;
    try {
      await this.agentRepository.manager.transaction(async (tx) => {
        const agent = await tx.findOne(Agent, {
          where: { id: event.agentId, organizationId: event.organizationId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!agent) {
          this.logger.warn(`[AUDIT] Agent not found: ${event.agentId}`);
          return;
        }
        agentName = agent.name;

        const entry: AgentAuditEntry = {
          action: event.action,
          userId: event.userId,
          timestamp: new Date().toISOString(),
          details: event.details,
        };

        const auditLog: AgentAuditEntry[] = agent.metadata?.auditLog || [];
        auditLog.push(entry);

        // Keep only the last MAX_AUDIT_ENTRIES
        const trimmedLog = auditLog.slice(-MAX_AUDIT_ENTRIES);

        // Defence in depth: scope the UPDATE by both id AND
        // organizationId. The findOne above already holds the row
        // lock and is org-scoped, but if event.organizationId ever
        // gets weakened upstream we still don't want an unscoped
        // UPDATE to drift across org boundaries.
        await tx.update(
          Agent,
          { id: event.agentId, organizationId: event.organizationId },
          { metadata: { ...agent.metadata, auditLog: trimmedLog } },
        );
      });

      this.logger.debug(
        `[AUDIT] ${event.action} on agent=${event.agentId} by user=${event.userId}`,
      );
    } catch (error) {
      // Audit logging should never break the main operation
      this.logger.error(
        `[AUDIT] Failed to log ${event.action} for agent=${event.agentId}: ${error.message}`,
      );
    }

    // log() never throws.
    await this.auditLogService?.log({
      organizationId: event.organizationId,
      userId: event.userId || undefined,
      action: TRAIL_ACTION[event.action] ?? AuditAction.UPDATE,
      resourceType: AuditResource.AGENT,
      resourceId: event.agentId,
      resourceName: agentName ?? (typeof event.details?.name === 'string' ? event.details.name : undefined),
      details: { ...(event.details ?? {}), agentEvent: event.action },
    });
  }

  /**
   * Retrieve audit log entries for an agent.
   */
  async getAuditLog(agentId: string, organizationId: string): Promise<AgentAuditEntry[]> {
    const agent = await this.agentRepository.findOne({
      where: { id: agentId, organizationId },
    });

    if (!agent) {
      return [];
    }

    return agent.metadata?.auditLog || [];
  }
}
