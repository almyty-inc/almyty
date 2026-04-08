import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';

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

@Injectable()
export class AgentAuditService {
  private readonly logger = new Logger(AgentAuditService.name);

  constructor(
    @InjectRepository(Agent)
    private agentRepository: Repository<Agent>,
  ) {}

  /**
   * Append an audit log entry to the agent's metadata.auditLog array.
   * Keeps the last MAX_AUDIT_ENTRIES entries (append-only, capped).
   */
  async log(event: AgentAuditEvent): Promise<void> {
    try {
      const agent = await this.agentRepository.findOne({
        where: { id: event.agentId, organizationId: event.organizationId },
      });

      if (!agent) {
        this.logger.warn(`[AUDIT] Agent not found: ${event.agentId}`);
        return;
      }

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
      // organizationId. The findOne above is already scoped, but the
      // previous `update(event.agentId, ...)` shape took only the id
      // — if event.organizationId ever gets weakened upstream, or if
      // the caller races itself against a delete-then-recreate with
      // the same uuid, the unscoped update would silently cross org
      // boundaries. Belt + braces.
      //
      // NOTE: there's still a read-modify-write race on concurrent
      // audit writes to the same agent — two overlapping callers
      // both see the same current log, both append, and one append
      // is silently lost. That's a correctness issue (not a
      // security one) and fixing it properly needs optimistic
      // concurrency at the schema level. Tracked as a follow-up.
      await this.agentRepository.update(
        { id: event.agentId, organizationId: event.organizationId },
        { metadata: { ...agent.metadata, auditLog: trimmedLog } },
      );

      this.logger.debug(
        `[AUDIT] ${event.action} on agent=${event.agentId} by user=${event.userId}`,
      );
    } catch (error) {
      // Audit logging should never break the main operation
      this.logger.error(
        `[AUDIT] Failed to log ${event.action} for agent=${event.agentId}: ${error.message}`,
      );
    }
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
