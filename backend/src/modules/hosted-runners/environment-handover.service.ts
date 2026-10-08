import { ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditLog, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HostedRunnersService, TERMINAL_HOSTED_STATES } from './hosted-runners.service';

/** Why an owner's environments are moving: the same reasons as every other resource's handover. */
export type EnvironmentHandoverReason = 'member_removed' | 'member_left' | 'user_deleted';

/** What a handover did inside the caller's transaction, and what to do once it committed. */
export interface EnvironmentHandover {
  audit: AuditLog[];
  /** Wake the reconcile loop for the stopped pods and tell the people concerned. Never throws. */
  afterCommit: () => Promise<void>;
}

type Row = Record<string, any>;

/** manager.query on an UPDATE ... RETURNING yields [rows, rowCount]. */
function returned(result: unknown): Row[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as Row[];
  return Array.isArray(result) ? (result as Row[]) : [];
}

/**
 * What happens to hosted environments when the person or team they
 * belong to goes (Frane, 2026-10-08).
 *
 * **The owner leaves the organization** (removed, left, or deleted their
 * account). Every environment they own, whatever its visibility, is handed
 * to one organization admin, chosen the same way every time: the
 * longest-standing owner, else the longest-standing admin. Its visibility
 * stays, its workspaces and their files stay. Their own workspaces (on any
 * environment of the organization) have their pod stopped at once, because
 * its Secret holds their connections and their model token, which is
 * revoked; the files are kept, and the workspace moves to the same admin
 * unless that admin already has one on that environment, in which case it
 * stays suspended under the departed owner until the retention window ends
 * (an admin can release it sooner). Every move is audited; the admin is
 * told.
 *
 * **A team is deleted.** An environment shared with the team keeps its
 * owner and becomes private (only the owner), with its tools; the owner can
 * share it again. Audited, and the owner is told in plain words.
 *
 * Both run inside the caller's transaction (ResourceHandoverHelper, from
 * OrganizationsService.removeMember / deleteTeam and UsersService's account
 * delete) and return what to do after commit.
 */
@Injectable()
export class EnvironmentHandoverService {
  private readonly logger = new Logger(EnvironmentHandoverService.name);

  constructor(
    private readonly auditLog: AuditLogService,
    private readonly hosted: HostedRunnersService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * Who receives a departing owner's environments: the organization's
   * longest-standing active owner other than them, else its
   * longest-standing active admin. Null when there is neither.
   */
  async receiverFor(manager: EntityManager, organizationId: string, excludeUserId: string): Promise<string | null> {
    const rows = returned(
      await manager.query(
        `SELECT "userId" FROM user_organizations
          WHERE "organizationId" = $1 AND "userId" <> $2 AND "isActive" = true
            AND ("inviteAccepted" = true OR "inviteToken" IS NULL)
            AND role IN ('owner', 'admin')
          ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, "joinedAt" ASC NULLS LAST, id ASC
          LIMIT 1`,
        [organizationId, excludeUserId],
      ),
    );
    return (rows[0]?.userId as string | undefined) ?? null;
  }

  async onMemberLeaving(
    manager: EntityManager,
    args: { organizationId: string; fromUserId: string; actorUserId: string; reason: EnvironmentHandoverReason },
  ): Promise<EnvironmentHandover> {
    const { organizationId, fromUserId, actorUserId, reason } = args;
    const audit: AuditLog[] = [];
    const environments = returned(
      await manager.query(
        `SELECT id, name, visibility FROM environments WHERE "organizationId" = $1 AND "ownerUserId" = $2 AND "deletedAt" IS NULL`,
        [organizationId, fromUserId],
      ),
    );
    const workspaces = returned(
      await manager.query(
        `SELECT id, "environmentId", "agentId", "runnerId" FROM workspaces
          WHERE "organizationId" = $1 AND "ownerUserId" = $2 AND kind = 'persistent' AND status IN ('active', 'suspended')`,
        [organizationId, fromUserId],
      ),
    );
    if (environments.length === 0 && workspaces.length === 0) return { audit, afterCommit: async () => undefined };

    const toUserId = await this.receiverFor(manager, organizationId, fromUserId);
    if (!toUserId) throw new ForbiddenException('Nobody is left to hand this member\'s hosted environments to: the organization needs an owner or admin');

    const handedOver: string[] = [];
    for (const env of environments) {
      await manager.query(`UPDATE environments SET "ownerUserId" = $1 WHERE id = $2`, [toUserId, env.id]);
      // Its tools carry the owner too (RunnerCapabilityPublisher.publishEnvironment).
      await manager.query(
        `UPDATE tools SET "createdBy" = $1 WHERE "organizationId" = $2 AND "runnerConfig"->>'environmentId' = $3`,
        [toUserId, organizationId, env.id],
      );
      handedOver.push(env.name);
      audit.push(
        await this.auditLog.logInTransaction(manager, {
          organizationId,
          userId: actorUserId,
          action: AuditAction.OWNERSHIP_TRANSFER,
          resourceType: AuditResource.ENVIRONMENT,
          resourceId: env.id,
          resourceName: env.name,
          changes: [{ field: 'ownerUserId', from: fromUserId, to: toUserId }],
          details: { reason, fromUserId, toUserId, visibility: env.visibility, filesKept: true },
        }),
      );
    }

    const stopped: string[] = [];
    for (const ws of workspaces) {
      const machine = returned(
        await manager.query(
          `SELECT id FROM hosted_runners WHERE "workspaceId" = $1 AND state <> ALL($2::text[])`,
          [ws.id, TERMINAL_HOSTED_STATES],
        ),
      )[0];
      if (machine) {
        // Stop the pod now; the reconcile loop does it once this commits.
        await manager.query(
          `UPDATE hosted_runners SET desired = desired || '{"replicas": 0, "wakeRequestedAt": null}'::jsonb WHERE id = $1`,
          [machine.id],
        );
        await manager.query(
          `UPDATE hosted_model_tokens SET "revokedAt" = now(), "revokedReason" = 'owner_left' WHERE "hostedRunnerId" = $1 AND "revokedAt" IS NULL`,
          [machine.id],
        );
        stopped.push(machine.id);
      }
      // The files stay. The workspace goes to the same admin, unless they
      // already keep one on that environment (one per person and agent).
      const clash = returned(
        await manager.query(
          `SELECT id FROM workspaces
            WHERE "environmentId" = $1 AND "ownerUserId" = $2 AND kind = 'persistent' AND status IN ('active', 'suspended')
              AND COALESCE("agentId", '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
          [ws.environmentId, toUserId, ws.agentId ?? null],
        ),
      ).length > 0;
      if (!clash) {
        await manager.query(`UPDATE workspaces SET "ownerUserId" = $1, "leaseHolder" = NULL, "leaseJob" = false, "leaseUntil" = NULL WHERE id = $2`, [toUserId, ws.id]);
        await manager.query(`UPDATE runners SET "ownerUserId" = $1 WHERE id = $2 AND kind = 'hosted'`, [toUserId, ws.runnerId]);
      }
      audit.push(
        await this.auditLog.logInTransaction(manager, {
          organizationId,
          userId: actorUserId,
          action: clash ? AuditAction.WORKSPACE_SUSPENDED : AuditAction.OWNERSHIP_TRANSFER,
          resourceType: AuditResource.HOSTED_RUNNER,
          resourceId: machine?.id ?? ws.id,
          ...(clash ? {} : { changes: [{ field: 'ownerUserId', from: fromUserId, to: toUserId }] }),
          details: {
            reason,
            workspaceId: ws.id,
            environmentId: ws.environmentId,
            fromUserId,
            toUserId: clash ? null : toUserId,
            podStopped: !!machine,
            filesKept: true,
            ...(clash ? { keptUnder: fromUserId, why: 'the receiver already has a workspace on this environment' } : {}),
          },
        }),
      );
    }

    return {
      audit,
      afterCommit: async () => {
        for (const id of stopped) await this.hosted.enqueue(id);
        if (handedOver.length === 0) return;
        const list = handedOver.join(', ');
        await this.notify({
          type: 'environments.handed_over',
          organizationId,
          userIds: [toUserId],
          title: handedOver.length === 1 ? 'A hosted environment is now yours' : 'Hosted environments are now yours',
          body: `A member left the organization, so ${handedOver.length === 1 ? 'their environment' : 'their environments'} ${list} ${handedOver.length === 1 ? 'is' : 'are'} now yours to look after. Nothing was deleted: the workspaces and their files are still there.`,
          link: '/runners',
          email: { template: 'environments.handed_over', params: { environments: list, count: handedOver.length } },
        });
      },
    };
  }

  async onTeamDeleted(
    manager: EntityManager,
    args: { organizationId: string; teamId: string; teamName?: string | null; actorUserId?: string | null },
  ): Promise<EnvironmentHandover> {
    const { organizationId, teamId, teamName, actorUserId } = args;
    const audit: AuditLog[] = [];
    const rows = returned(
      await manager.query(
        `UPDATE environments SET visibility = 'private', "teamId" = NULL
          WHERE "organizationId" = $1 AND "teamId" = $2
          RETURNING id, name, "ownerUserId"`,
        [organizationId, teamId],
      ),
    );
    const byOwner = new Map<string, string[]>();
    for (const env of rows) {
      // Its tools follow it (the team demotion just made them org-wide).
      await manager.query(
        `UPDATE tools SET visibility = 'private', "teamId" = NULL, "createdBy" = $1
          WHERE "organizationId" = $2 AND "runnerConfig"->>'environmentId' = $3`,
        [env.ownerUserId, organizationId, env.id],
      );
      byOwner.set(env.ownerUserId, [...(byOwner.get(env.ownerUserId) ?? []), env.name]);
      audit.push(
        await this.auditLog.logInTransaction(manager, {
          organizationId,
          userId: actorUserId ?? undefined,
          action: AuditAction.VISIBILITY_CHANGE,
          resourceType: AuditResource.ENVIRONMENT,
          resourceId: env.id,
          resourceName: env.name,
          changes: [
            { field: 'visibility', from: 'team', to: 'private' },
            { field: 'teamId', from: teamId, to: null },
          ],
          details: { reason: 'team_deleted', teamId, teamName: teamName ?? null, ownerUserId: env.ownerUserId },
        }),
      );
    }
    return {
      audit,
      afterCommit: async () => {
        const team = teamName ? `The team ${teamName}` : 'A team';
        for (const [ownerUserId, names] of byOwner) {
          const list = names.join(', ');
          await this.notify({
            type: 'environments.unshared',
            organizationId,
            userIds: [ownerUserId],
            title: names.length === 1 ? 'Your environment is private again' : 'Your environments are private again',
            body: `${team} was deleted, so ${list} ${names.length === 1 ? 'is' : 'are'} now private: only you can see and use ${names.length === 1 ? 'it' : 'them'}. Share ${names.length === 1 ? 'it' : 'them'} again from the environment page if others still need ${names.length === 1 ? 'it' : 'them'}.`,
            link: '/runners',
            email: { template: 'environments.unshared', params: { environments: list, teamName: teamName ?? null, count: names.length } },
          });
        }
      },
    };
  }

  private async notify(input: Parameters<NotificationsService['emit']>[0]): Promise<void> {
    try {
      await this.notifications?.emit(input);
    } catch (err: any) {
      this.logger.warn(`Could not send ${input.type}: ${err?.message ?? err}`);
    }
  }
}
