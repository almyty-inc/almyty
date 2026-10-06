import { createHash } from 'crypto';

import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import type { AuditLogOptions } from '../audit-log/audit-log.service';

/**
 * A reference to a person for the audit log that is not the person: the
 * same identifier in the same organization always gives the same
 * reference, so an auditor holding the identifier can find the entries,
 * and the log itself never holds a phone number, an email address or a
 * platform id.
 */
export function subjectRef(organizationId: string, identifier: string): string {
  const normalized = (identifier || '').trim().toLowerCase();
  return `sha256:${createHash('sha256').update(`${organizationId}:${normalized}`).digest('hex').slice(0, 24)}`;
}

/** One export or erasure of a person's data, as the audit log records it. */
export interface VisitorDataAuditEntry {
  action: AuditAction.VISITOR_DATA_EXPORT | AuditAction.VISITOR_DATA_ERASE;
  organizationId: string;
  /** The agent whose channels held the data. */
  agentId: string;
  agentName?: string | null;
  /** The owner or admin who answered a request; absent when the visitor asked themselves. */
  userId?: string | null;
  /** The channel the person was found on, or `all` for every channel of the agent. */
  channel: string;
  /** What identified the person; only its hash (subjectRef) is written. */
  identifier: string;
  /** How many of each kind of row; never their content. */
  counts: Record<string, number>;
}

/**
 * The audit row of one export or erasure: who, which agent and channel,
 * a hashed reference to the person and the counts. Never the identifier
 * or any of the content, so the record of an erasure does not keep what
 * was erased.
 */
export function visitorDataAudit(entry: VisitorDataAuditEntry): AuditLogOptions {
  return {
    organizationId: entry.organizationId,
    ...(entry.userId ? { userId: entry.userId } : {}),
    action: entry.action,
    resourceType: AuditResource.AGENT,
    resourceId: entry.agentId,
    ...(entry.agentName ? { resourceName: entry.agentName } : {}),
    details: {
      request: entry.action === AuditAction.VISITOR_DATA_ERASE ? 'erase' : 'export',
      by: entry.userId ? 'owner' : 'visitor',
      channel: entry.channel,
      subject: subjectRef(entry.organizationId, entry.identifier),
      counts: entry.counts,
    },
  };
}
