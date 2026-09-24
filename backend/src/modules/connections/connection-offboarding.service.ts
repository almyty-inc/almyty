import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { AuditAction, AuditLog, AuditResource } from '../../entities/audit-log.entity';
import { Credential } from '../../entities/credential.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ConnectionsService } from './connections.service';
import { WipedConnection, wipeMemberConnections } from './member-connection-offboarding';

export type OffboardingReason = 'member_removed' | 'member_left' | 'scim_deprovisioned' | 'user_deleted';

const HEALTH_ERROR: Record<OffboardingReason, string> = {
  member_removed: 'the owner left the organization',
  member_left: 'the owner left the organization',
  scim_deprovisioned: 'the owner was deprovisioned by the identity provider',
  user_deleted: "the owner's account was deleted",
};

/**
 * What happens to a person's own connections (Personal and Private) when
 * they are offboarded: removed from an organization, deprovisioned by
 * SCIM, or deleted.
 *
 * Two steps, in this order, because they have different failure modes:
 *
 *  1. Locally, inside the caller's transaction, always: the stored secret
 *     is wiped, the row is marked revoked and inactive, and its grants
 *     are dropped (`wipeMemberConnections`). Nothing a provider says can
 *     stop this.
 *  2. At the provider, after commit, best-effort: the grant the person
 *     gave (an OAuth token, a minted key) is revoked there too, so it is
 *     dead even outside almyty -- a copy of the token in a log, a cache,
 *     another system. Wiping only our copy left it valid at the provider
 *     until it expired, which for most API keys is never. Each attempt
 *     is audited with what the provider answered.
 */
@Injectable()
export class ConnectionOffboardingService {
  private readonly logger = new Logger(ConnectionOffboardingService.name);

  constructor(
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    private readonly connections: ConnectionsService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Step 1 on the caller's transaction. Returns the audit rows (publish
   * them after commit) and what step 2 needs.
   */
  async wipeInTransaction(
    manager: EntityManager,
    args: { organizationId: string | null; userId: string; actorUserId: string | null; reason: OffboardingReason },
  ): Promise<{ audit: AuditLog[]; wiped: WipedConnection[] }> {
    const wiped = await wipeMemberConnections(manager, {
      organizationId: args.organizationId,
      ownerUserId: args.userId,
      healthError: HEALTH_ERROR[args.reason],
    });
    const audit: AuditLog[] = [];
    for (const row of wiped) {
      audit.push(
        await this.auditLog.logInTransaction(manager, {
          organizationId: row.organizationId,
          userId: args.actorUserId ?? undefined,
          action: AuditAction.CONNECTION_DISCONNECT,
          resourceType: AuditResource.CONNECTION,
          resourceId: row.id,
          resourceName: row.name ?? undefined,
          details: {
            reason: args.reason,
            ownerUserId: args.userId,
            connectorKey: row.connectorKey ?? null,
            owner: row.visibility === 'private' ? 'private' : 'user',
            secretWiped: true,
            providerRevoke: 'after_commit',
            grantsRemoved: row.grantsRemoved,
          },
        }),
      );
    }
    return { audit, wiped };
  }

  /**
   * Step 2, after the wipe committed. Never throws: every outcome, a
   * failure included, is an audit row, and the local wipe stands.
   */
  async revokeAtProviders(
    wiped: WipedConnection[],
    ctx: { userId: string; actorUserId: string | null; reason: OffboardingReason },
  ): Promise<void> {
    for (const row of wiped) {
      if (!row.previousConfig || Object.keys(row.previousConfig).length === 0) continue;
      const outcome = await this.connections.revokeAtProvider(
        {
          id: row.id,
          organizationId: row.organizationId,
          name: row.name ?? '',
          connectorKey: row.connectorKey,
          metadata: row.metadata ?? {},
          config: row.previousConfig,
        } as Credential,
        ctx.actorUserId ?? undefined,
      );
      if (!outcome.attempted) continue;
      if (!outcome.revoked) {
        this.logger.warn(`provider revoke of connection ${row.id} (${row.connectorKey}) failed: ${outcome.error}`);
      }
      await this.auditLog.log({
        organizationId: row.organizationId,
        userId: ctx.actorUserId ?? undefined,
        action: AuditAction.CONNECTION_REVOKE,
        resourceType: AuditResource.CONNECTION,
        resourceId: row.id,
        resourceName: row.name ?? undefined,
        details: {
          reason: ctx.reason,
          ownerUserId: ctx.userId,
          connectorKey: row.connectorKey ?? null,
          stage: 'provider',
          revoked: outcome.revoked,
          via: outcome.via ?? null,
          error: outcome.error ?? null,
        },
      });
    }
  }

  /**
   * Both steps, for a caller with no transaction of its own to join
   * (SCIM deprovisioning, account deletion).
   */
  async offboard(args: {
    organizationId: string | null;
    userId: string;
    actorUserId: string | null;
    reason: OffboardingReason;
  }): Promise<void> {
    const { audit, wiped } = await this.credentials.manager.transaction((manager) =>
      this.wipeInTransaction(manager, args),
    );
    this.auditLog.publishCommitted(audit);
    await this.revokeAtProviders(wiped, args);
  }
}
