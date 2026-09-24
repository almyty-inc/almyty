import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditLog, AuditResource } from '../../entities/audit-log.entity';
import { Runner } from '../../entities/runner.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { RunnerService } from '../runner/runner.service';

/**
 * The resource tables that carry the visibility tiers, with the column
 * that names a private row's owner (1750808000000-PrivateVisibility).
 * Runners are handled apart: see handOverPrivateResources.
 */
export const OWNED_RESOURCE_TABLES: ReadonlyArray<{
  table: string;
  ownerColumn: 'createdBy' | 'ownerUserId';
  resourceType: AuditResource;
}> = [
  { table: 'agents', ownerColumn: 'createdBy', resourceType: AuditResource.AGENT },
  { table: 'tools', ownerColumn: 'createdBy', resourceType: AuditResource.TOOL },
  { table: 'apis', ownerColumn: 'ownerUserId', resourceType: AuditResource.API },
  { table: 'gateways', ownerColumn: 'ownerUserId', resourceType: AuditResource.GATEWAY },
  { table: 'llm_providers', ownerColumn: 'ownerUserId', resourceType: AuditResource.LLM_PROVIDER },
  { table: 'credentials', ownerColumn: 'ownerUserId', resourceType: AuditResource.CREDENTIAL },
];

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
  ) {}

  /**
   * A member is leaving `organizationId`: every private row they own in
   * it moves to `toUserId` and stays private, so "just me" is still one
   * person. Their private runners are deleted instead -- a runner is a
   * binding to the departed person's own machine, and `runners` allows
   * one runner per (owner, organization), so it could not move anyway.
   * Org- and team-visible rows are untouched: everyone who could use
   * them still can.
   */
  async handOverPrivateResources(
    manager: EntityManager,
    args: {
      organizationId: string;
      fromUserId: string;
      toUserId: string;
      actorUserId: string;
      reason: 'member_removed' | 'member_left';
    },
  ): Promise<AuditLog[]> {
    const { organizationId, fromUserId, toUserId, actorUserId, reason } = args;
    const audit: AuditLog[] = [];

    // Runners first: a runner publishes its methods as tools with the
    // runner's own visibility and owner, so a private runner's tools are
    // private tools of the departed member. They go with the runner
    // rather than being handed over below.
    const privateRunners = await manager.getRepository(Runner).find({
      where: { organizationId, ownerUserId: fromUserId, visibility: 'private' },
    });
    for (const runner of privateRunners) {
      const { id, name } = runner;
      await this.runners.deleteForDepartedOwner(runner, manager);
      audit.push(
        await this.auditLog.logInTransaction(manager, {
          organizationId,
          userId: actorUserId,
          action: AuditAction.DELETE,
          resourceType: AuditResource.RUNNER,
          resourceId: id,
          resourceName: name,
          details: { reason, ownerUserId: fromUserId, visibility: 'private' },
        }),
      );
    }

    for (const { table, ownerColumn, resourceType } of OWNED_RESOURCE_TABLES) {
      const rows = returnedRows(
        await manager.query(
          `UPDATE ${table} SET "${ownerColumn}" = $1
            WHERE "organizationId" = $2 AND visibility = 'private' AND "${ownerColumn}" = $3
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

    return audit;
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
