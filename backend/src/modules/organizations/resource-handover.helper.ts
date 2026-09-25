import { ForbiddenException, Inject, Injectable, forwardRef } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditLog, AuditResource } from '../../entities/audit-log.entity';
import { Runner } from '../../entities/runner.entity';
import { OrganizationRole, UserOrganization } from '../../entities/user-organization.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { RunnerService } from '../runner/runner.service';
import { ConnectionOffboardingService } from '../connections/connection-offboarding.service';
import { memberConnectionSql, WipedConnection } from '../connections/member-connection-offboarding';

/**
 * Why a person's resources are being handed over: removed by someone,
 * left on their own, or their account was deleted.
 */
export type HandoverReason = 'member_removed' | 'member_left' | 'user_deleted';

/**
 * The resource tables that carry the visibility tiers, with the column
 * that names a private row's owner (1750808000000-PrivateVisibility).
 * Runners and connections are handled apart: see handOverPrivateResources.
 * `except` narrows a table's handover (credentials: not the member's own
 * connections, which are revoked instead).
 */
export const OWNED_RESOURCE_TABLES: ReadonlyArray<{
  table: string;
  ownerColumn: 'createdBy' | 'ownerUserId';
  resourceType: AuditResource;
  except?: string;
}> = [
  { table: 'agents', ownerColumn: 'createdBy', resourceType: AuditResource.AGENT },
  { table: 'tools', ownerColumn: 'createdBy', resourceType: AuditResource.TOOL },
  { table: 'apis', ownerColumn: 'ownerUserId', resourceType: AuditResource.API },
  { table: 'gateways', ownerColumn: 'ownerUserId', resourceType: AuditResource.GATEWAY },
  { table: 'llm_providers', ownerColumn: 'ownerUserId', resourceType: AuditResource.LLM_PROVIDER },
  { table: 'credentials', ownerColumn: 'ownerUserId', resourceType: AuditResource.CREDENTIAL, except: memberConnectionSql() },
];

/**
 * A connection a member made for themselves; see
 * connections/member-connection-offboarding.ts. Re-exported because the
 * credentials handover above excludes exactly these rows.
 */
export { memberConnectionSql };

/** Every table with a teamId the team FK sets to NULL (1745340000000). */
export const TEAM_SCOPED_TABLES: ReadonlyArray<{ table: string; resourceType: AuditResource }> = [
  ...OWNED_RESOURCE_TABLES.map(({ table, resourceType }) => ({ table, resourceType })),
  { table: 'runners', resourceType: AuditResource.RUNNER },
];

type ReturnedRow = { id: string; name: string | null };

/** manager.query on an UPDATE ... RETURNING yields [rows, rowCount]. */
function returnedRows(result: unknown): ReturnedRow[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as ReturnedRow[];
  return Array.isArray(result) ? (result as ReturnedRow[]) : [];
}

/**
 * What happens to resources when the thing that scoped them goes away:
 * a member leaving the organization, or a team being deleted.
 *
 * Both run inside the caller's transaction and write one audit row per
 * resource they touch, in that same transaction. The caller publishes
 * the returned audit rows (AuditLogService.publishCommitted) after
 * commit.
 */
@Injectable()
export class ResourceHandoverHelper {
  constructor(
    private readonly auditLog: AuditLogService,
    @Inject(forwardRef(() => RunnerService))
    private readonly runners: RunnerService,
    @Inject(forwardRef(() => ConnectionOffboardingService))
    private readonly offboarding: ConnectionOffboardingService,
  ) {}

  /**
   * A member is leaving `organizationId`: removed, left on their own, or
   * their account was deleted. What they leave behind:
   *
   * - Private rows they own (agents, tools, APIs, gateways, providers,
   *   plain credentials) move to `toUserId` and stay private, so "just
   *   me" is still one person.
   * - Their runners are deregistered, whatever the visibility. A runner
   *   is a daemon on the departed person's own machine, holding a token
   *   the organization cannot take back; keeping an org- or team-visible
   *   one "ownerless" would keep dispatching the organization's work, and
   *   the secrets and data in it, to hardware the organization no longer
   *   has any say over. Its tools go with it (runners are one per owner
   *   and organization, so it could not be handed over either).
   * - Their own connections (Personal and Private) are revoked: the
   *   stored secret is wiped, the row is marked revoked and inactive,
   *   and every grant on it is dropped. A connection is the member's
   *   account at a third party; handing it to someone else would let
   *   them act as the departed person there, and leaving it working (a
   *   Personal connection shared by grant still resolves) would keep the
   *   organization using a former member's account. The row stays so
   *   whatever referenced it fails visibly and can be reconnected. The
   *   wiped secrets go to `wipedConnections` so the caller can also
   *   revoke the grants at the providers once this commits
   *   (revokeWipedConnectionsAtProviders).
   * - Grants that name them as a user are removed.
   *
   * Org- and team-visible rows other than runners are untouched:
   * everyone who could use them still can.
   */
  async handOverPrivateResources(
    manager: EntityManager,
    args: {
      organizationId: string;
      fromUserId: string;
      toUserId: string;
      actorUserId: string;
      reason: HandoverReason;
      /**
       * Receives the connections wiped here, secrets as they were, for
       * ConnectionOffboardingService.revokeAtProviders after commit.
       */
      wipedConnections?: WipedConnection[];
    },
  ): Promise<AuditLog[]> {
    const { organizationId, fromUserId, toUserId, actorUserId, reason, wipedConnections } = args;
    const audit: AuditLog[] = [];

    // Runners first: a runner publishes its methods as tools with the
    // runner's own visibility and owner, so a private runner's tools are
    // private tools of the departed member. They go with the runner
    // rather than being handed over below.
    const runners = await manager.getRepository(Runner).find({
      where: { organizationId, ownerUserId: fromUserId },
    });
    for (const runner of runners) {
      const { id, name, visibility, teamId } = runner;
      await this.runners.deleteForDepartedOwner(runner, manager);
      audit.push(
        await this.auditLog.logInTransaction(manager, {
          organizationId,
          userId: actorUserId,
          action: AuditAction.DELETE,
          resourceType: AuditResource.RUNNER,
          resourceId: id,
          resourceName: name,
          details: { reason, ownerUserId: fromUserId, visibility: visibility ?? 'org', teamId: teamId ?? null },
        }),
      );
    }

    // Their own connections: wiped here, in the removal transaction, and
    // revoked at the provider by the caller once it commits
    // (ConnectionOffboardingService says why both).
    const { audit: connectionAudit, wiped } = await this.offboarding.wipeInTransaction(manager, {
      organizationId,
      userId: fromUserId,
      actorUserId,
      reason,
    });
    audit.push(...connectionAudit);
    wipedConnections?.push(...wiped);
    audit.push(...(await this.removeUserGrants(manager, { organizationId, fromUserId, actorUserId, reason })));

    for (const { table, ownerColumn, resourceType, except } of OWNED_RESOURCE_TABLES) {
      const rows = returnedRows(
        await manager.query(
          `UPDATE ${table} SET "${ownerColumn}" = $1
            WHERE "organizationId" = $2 AND visibility = 'private' AND "${ownerColumn}" = $3${except ? ` AND NOT ${except}` : ''}
            RETURNING id, name`,
          [toUserId, organizationId, fromUserId],
        ),
      );
      for (const row of rows) {
        audit.push(
          await this.auditLog.logInTransaction(manager, {
            organizationId,
            userId: actorUserId,
            action: AuditAction.OWNERSHIP_TRANSFER,
            resourceType,
            resourceId: row.id,
            resourceName: row.name ?? undefined,
            changes: [{ field: ownerColumn, from: fromUserId, to: toUserId }],
            details: { reason, fromUserId, toUserId, visibility: 'private' },
          }),
        );
      }
    }

    // Approvals their private agents asked for go with the agents: still
    // private, now the new owner's to see and decide. Not audited apart:
    // each follows an agent whose transfer is audited above.
    await manager.query(
      `UPDATE approval_requests SET "ownerUserId" = $1
        WHERE "organizationId" = $2 AND visibility = 'private' AND "ownerUserId" = $3`,
      [toUserId, organizationId, fromUserId],
    );

    return audit;
  }

  /** Grants that name the departed member as a user principal. */
  private async removeUserGrants(
    manager: EntityManager,
    args: { organizationId: string; fromUserId: string; actorUserId: string; reason: string },
  ): Promise<AuditLog[]> {
    const { organizationId, fromUserId, actorUserId, reason } = args;
    const removed = returnedRows(
      await manager.query(
        `DELETE FROM connection_grants
          WHERE "organizationId" = $1 AND "principalType" = 'user' AND "principalId" = $2
          RETURNING id, "connectionId", permission`,
        [organizationId, fromUserId],
      ),
    ) as unknown as Array<{ id: string; connectionId: string; permission: string }>;
    const audit: AuditLog[] = [];
    for (const grant of removed) {
      audit.push(
        await this.auditLog.logInTransaction(manager, {
          organizationId,
          userId: actorUserId,
          action: AuditAction.CONNECTION_REVOKE_GRANT,
          resourceType: AuditResource.CONNECTION,
          resourceId: grant.connectionId,
          details: { reason, grantId: grant.id, principalType: 'user', principalId: fromUserId, permission: grant.permission },
        }),
      );
    }
    return audit;
  }

  /**
   * After the removal committed: revoke the connections
   * handOverPrivateResources wiped at their providers. Best-effort and
   * audited per connection; never throws.
   */
  revokeWipedConnectionsAtProviders(
    wiped: WipedConnection[],
    ctx: { userId: string; actorUserId: string; reason: HandoverReason },
  ): Promise<void> {
    return this.offboarding.revokeAtProviders(wiped, ctx);
  }

  /** Publish the audit rows a handover wrote, once its transaction committed. */
  publishCommitted(audit: AuditLog[]): void {
    this.auditLog.publishCommitted(audit);
  }

  /**
   * Who receives a departing person's private rows when nobody in
   * particular removed them (they left on their own, or the account was
   * deleted by someone outside this organization): the organization's
   * longest-standing active owner other than them. There always is one
   * where the last owner cannot leave; where there is not, the handover
   * is refused rather than the rows left to nobody.
   */
  async longestStandingOtherOwner(
    manager: EntityManager,
    organizationId: string,
    excludeUserId: string,
  ): Promise<string> {
    const owner = await manager
      .getRepository(UserOrganization)
      .createQueryBuilder('m')
      .where('m.organizationId = :organizationId', { organizationId })
      .andWhere('m.role = :role', { role: OrganizationRole.OWNER })
      .andWhere('m.isActive = true')
      .andWhere('m.userId <> :excludeUserId', { excludeUserId })
      .orderBy('m.joinedAt', 'ASC', 'NULLS LAST')
      .addOrderBy('m.id', 'ASC')
      .getOne();
    if (!owner) {
      throw new ForbiddenException('Cannot remove the last owner of the organization');
    }
    return owner.userId;
  }

  /**
   * A team is being deleted: its resources become org-wide. This is
   * what the teamId FK's ON DELETE SET NULL was meant to do, and the
   * CHECK ('team' needs a teamId) made it fail instead. The trigger
   * from 1750809000000-TeamDeleteDemotesResources does the same for
   * any other delete path; doing it here first is what gets it audited.
   */
  async demoteTeamResources(
    manager: EntityManager,
    args: { organizationId: string; teamId: string; teamName?: string | null; actorUserId?: string | null },
  ): Promise<AuditLog[]> {
    const { organizationId, teamId, teamName, actorUserId } = args;
    const audit: AuditLog[] = [];

    for (const { table, resourceType } of TEAM_SCOPED_TABLES) {
      const rows = returnedRows(
        await manager.query(
          `UPDATE ${table} SET visibility = 'org', "teamId" = NULL
            WHERE "teamId" = $1
            RETURNING id, name`,
          [teamId],
        ),
      );
      for (const row of rows) {
        audit.push(
          await this.auditLog.logInTransaction(manager, {
            organizationId,
            userId: actorUserId ?? undefined,
            action: AuditAction.VISIBILITY_CHANGE,
            resourceType,
            resourceId: row.id,
            resourceName: row.name ?? undefined,
            changes: [
              { field: 'visibility', from: 'team', to: 'org' },
              { field: 'teamId', from: teamId, to: null },
            ],
            details: { reason: 'team_deleted', teamId, teamName: teamName ?? null },
          }),
        );
      }
    }

    return audit;
  }
}
