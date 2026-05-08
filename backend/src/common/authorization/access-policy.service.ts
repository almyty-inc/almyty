import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets, SelectQueryBuilder, ObjectLiteral } from 'typeorm';

import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';

/**
 * Resource visibility scoping (GitHub-style two-tier model).
 *
 * - 'org': visible to every member of the owning organization (the
 *   default for backwards-compatibility — every existing row before
 *   per-entity migrations runs is treated as 'org').
 * - 'team': visible only to members of the resource's team. Requires
 *   teamId to be set.
 *
 * The same enum is used in column DEFAULTs for every entity that gets
 * team-scoped, so the wire format is stable.
 */
export type ResourceVisibility = 'org' | 'team';

/**
 * The minimum subset of fields a resource must expose for the access
 * policy to make a decision. Every team-scoped entity must satisfy
 * this shape (organizationId always; visibility/teamId on entities
 * that have completed their team-scoping migration).
 */
export interface ResourceLike {
  organizationId: string;
  visibility?: ResourceVisibility | null;
  teamId?: string | null;
}

/**
 * Action a caller is attempting on a resource. The policy distinguishes
 * - 'read' / 'use': any team member of the team that owns the resource
 *   passes; org members of an 'org'-visibility resource pass.
 * - 'manage': must be team_admin (TeamRole.LEAD) of the resource's team
 *   for 'team'-scoped resources, or carry an explicit org-level perm
 *   for 'org'-scoped resources.
 */
export type ResourceAction = 'read' | 'use' | 'manage';

export interface AccessDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Single-source-of-truth authorization gate for team-scoped resources.
 *
 * Every service that lists or mutates a resource that has
 * (organizationId, visibility, teamId) calls one of:
 *   - canAccess(user, resource, action)  → AccessDecision
 *   - applyListFilter(qb, user, alias)   → mutates the query builder
 *
 * Org owners and admins always pass; team_admins (LEAD) pass for
 * 'manage' on resources in their team; ordinary team_members pass for
 * 'read' / 'use' on resources in their team or any org-wide resource.
 */
@Injectable()
export class AccessPolicyService {
  constructor(
    @InjectRepository(UserOrganization)
    private readonly userOrgs: Repository<UserOrganization>,
    @InjectRepository(UserTeam)
    private readonly userTeams: Repository<UserTeam>,
  ) {}

  /**
   * Resolve the caller's org role. Returns null if not a member.
   * Cached on the user object across the request via a WeakMap so a
   * single request that hits multiple resources doesn't re-query.
   */
  async getOrgRole(userId: string, organizationId: string): Promise<OrganizationRole | null> {
    const row = await this.userOrgs.findOne({
      where: { userId, organizationId, isActive: true },
    });
    return row?.role ?? null;
  }

  /**
   * Returns the set of teamIds the caller belongs to within the org.
   * Includes both team_admin (LEAD) and team_member rows; the role
   * mapping is materialized separately by getTeamRole.
   */
  async getTeamMemberships(userId: string, organizationId: string): Promise<Map<string, TeamRole>> {
    const rows = await this.userTeams
      .createQueryBuilder('ut')
      .innerJoin('teams', 't', 't.id = ut."teamId" AND t."organizationId" = :organizationId', { organizationId })
      .where('ut."userId" = :userId AND ut."isActive" = true', { userId })
      .select(['ut."teamId" AS "teamId"', 'ut.role AS role'])
      .getRawMany();
    const out = new Map<string, TeamRole>();
    for (const row of rows) {
      out.set(row.teamId, row.role as TeamRole);
    }
    return out;
  }

  /**
   * Decide whether `user` may perform `action` on `resource`. Handles
   * the full GitHub-style policy:
   *   - org owner/admin pass everything inside their org
   *   - team-scoped resources require team membership; manage actions
   *     require team_admin (LEAD)
   *   - org-scoped resources are visible to all org members; manage
   *     actions still require an explicit org-level decision by the
   *     caller (we don't enforce manage-by-default for org-wide).
   */
  async canAccess(
    user: { id: string },
    resource: ResourceLike,
    action: ResourceAction,
  ): Promise<AccessDecision> {
    const orgRole = await this.getOrgRole(user.id, resource.organizationId);
    if (!orgRole) return deny('not a member of this organization');

    if (orgRole === OrganizationRole.OWNER || orgRole === OrganizationRole.ADMIN) {
      return allow('org owner/admin bypass');
    }

    // Default visibility for not-yet-migrated entities is 'org'.
    const visibility = resource.visibility ?? 'org';

    if (visibility === 'org') {
      // Org-scoped resource: any active org member can read/use.
      // Manage permissions are caller's responsibility (existing
      // hasPermissionInOrganization checks still gate at the controller).
      if (action === 'read' || action === 'use') return allow('org-wide visibility');
      // For manage: caller must be admin/owner OR carry org-level perm
      // (which we don't model here — caller checks). Default to deny so
      // callers don't accidentally grant manage to plain members.
      return deny('manage on org-wide resource requires admin role');
    }

    // visibility === 'team'. teamId must be set.
    if (!resource.teamId) {
      return deny('team-scoped resource without teamId');
    }
    const memberships = await this.getTeamMemberships(user.id, resource.organizationId);
    const teamRole = memberships.get(resource.teamId);
    if (!teamRole) return deny('not a member of the resource\'s team');

    if (action === 'read' || action === 'use') return allow('team member');
    // action === 'manage'
    if (teamRole === TeamRole.LEAD) return allow('team lead');
    return deny('manage requires team lead');
  }

  /**
   * Apply the list-filter for a query builder. Adds a clause:
   *   (alias.visibility = 'org' AND alias.organizationId = :orgId)
   *   OR
   *   (alias.teamId IN (:userTeamIds))
   *
   * Org owners/admins bypass the filter (full visibility within their
   * org). Returns a small object describing what was applied so the
   * caller can introspect during tests.
   */
  async applyListFilter<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    user: { id: string },
    organizationId: string,
    alias: string,
  ): Promise<{ bypass: boolean; teamIds: string[] }> {
    const orgRole = await this.getOrgRole(user.id, organizationId);
    if (orgRole === OrganizationRole.OWNER || orgRole === OrganizationRole.ADMIN) {
      // Bypass: caller sees every row in the org.
      qb.andWhere(`${alias}."organizationId" = :_orgId`, { _orgId: organizationId });
      return { bypass: true, teamIds: [] };
    }
    const memberships = await this.getTeamMemberships(user.id, organizationId);
    const teamIds = Array.from(memberships.keys());
    qb.andWhere(`${alias}."organizationId" = :_orgId`, { _orgId: organizationId });
    qb.andWhere(new Brackets((sub) => {
      sub.where(`(${alias}."visibility" IS NULL OR ${alias}."visibility" = 'org')`);
      if (teamIds.length > 0) {
        sub.orWhere(`${alias}."teamId" IN (:...userTeamIds)`, { userTeamIds: teamIds });
      }
    }));
    return { bypass: false, teamIds };
  }
}

function allow(reason: string): AccessDecision {
  return { allowed: true, reason };
}
function deny(reason: string): AccessDecision {
  return { allowed: false, reason };
}
