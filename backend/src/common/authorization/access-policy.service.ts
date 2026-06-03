import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
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
    return out;
  }

  /**
   * Validate that the caller can scope a resource to the given teamId.
   * - The team must exist in the org (prevents cross-org teamId attacks
   *   where a user mints a resource with a teamId pointing at a team
   *   in a different org and then reads it back via the listing path).
   * - The caller must either be an org owner/admin or have a team
   *   membership in that team. Otherwise the create/update path lets
   *   a member grant team-admin reach by setting visibility=team +
   *   teamId=<a team they don't belong to>.
   *
   * Throws NotFoundException when the team isn't in the org so we
   * don't leak the existence of teams in other orgs.
   * Throws ForbiddenException when the caller has no path to that
   * team.
   *
   * Pass through when visibility !== 'team' OR teamId is null —
   * org-wide resources don't need the check.
   */
  async assertCanScopeToTeam(
    userId: string,
    organizationId: string,
    visibility: 'org' | 'team' | undefined,
    teamId: string | null | undefined,
  ): Promise<void> {
    if (visibility !== 'team' || teamId == null) return;

    // 1. Org owner/admin bypass — they can create/manage anything.
    const orgRole = await this.getOrgRole(userId, organizationId);
    if (orgRole === OrganizationRole.OWNER || orgRole === OrganizationRole.ADMIN) {
      // Still verify the team is in this org; otherwise an admin
      // could accidentally bind a resource to a team in another org
      // they happen to also be an admin of.
      const teamCount = await this.userOrgs.manager
        .getRepository('Team')
        .count({ where: { id: teamId, organizationId, isActive: true } });
      if (teamCount === 0) {
        throw new NotFoundException('Team not found');
      }
      return;
    }

    // 2. Non-admin path — the caller must be a member of the team
    //    AND the team must be in the org. We can verify both with
    //    one query: the join in getTeamMemberships filters by
    //    organizationId already, so the map only contains in-org
    //    teams the caller belongs to.
    const memberships = await this.getTeamMemberships(userId, organizationId);
    if (!memberships.has(teamId)) {
      // Surface as NotFound to avoid leaking 'this team exists but
      // you're not on it' to a non-admin — consistent with
      // assertTeamInOrg's existing behavior in OrganizationsService.
      throw new NotFoundException('Team not found');
    }
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
