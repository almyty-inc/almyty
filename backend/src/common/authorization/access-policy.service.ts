import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets, SelectQueryBuilder, ObjectLiteral, FindOptionsWhere, In, Not } from 'typeorm';

import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { isEffectiveMembership } from './membership';

/**
 * Resource visibility scoping (GitHub-style tiers plus a personal one).
 *
 * - 'org': visible to every member of the owning organization (the
 *   default for backwards-compatibility — every existing row before
 *   per-entity migrations runs is treated as 'org').
 * - 'team': visible only to members of the resource's team. Requires
 *   teamId to be set.
 * - 'private': visible to, and usable by, the user who owns it and
 *   nobody else -- not other members, not team leads, and not org
 *   owners/admins either. "Just me" has to mean just me, or it is a
 *   label. Requires an owner (see resourceOwnerId) and no teamId.
 *
 * The same values are used in column DEFAULTs and CHECK constraints for
 * every entity that is visibility-scoped, so the wire format is stable.
 */
export type ResourceVisibility = 'org' | 'team' | 'private';

/** Every visibility tier, for DTO validation (`@IsIn(RESOURCE_VISIBILITIES)`). */
export const RESOURCE_VISIBILITIES: readonly ResourceVisibility[] = ['org', 'team', 'private'];

/**
 * The minimum subset of fields a resource must expose for the access
 * policy to make a decision. Every scoped entity must satisfy this
 * shape: organizationId always; visibility/teamId on entities that have
 * completed their team-scoping migration; an owner column on entities
 * that can be private. The owner lives under different names on
 * different entities (runners/credentials/apis/gateways/llm_providers
 * say `ownerUserId`, agents/tools say `createdBy`); resourceOwnerId
 * reads whichever is present.
 */
export interface ResourceLike {
  organizationId: string;
  visibility?: ResourceVisibility | null;
  teamId?: string | null;
  ownerUserId?: string | null;
  createdBy?: string | null;
}

/** The user a private resource belongs to, or null when none is recorded. */
export function resourceOwnerId(resource: Pick<ResourceLike, 'ownerUserId' | 'createdBy'>): string | null {
  return resource.ownerUserId ?? resource.createdBy ?? null;
}

/**
 * Normalise a requested (visibility, teamId) pair before it is written.
 * 'org' and 'private' never carry a team. Services call this on create
 * and update so a stray teamId cannot trip the table's CHECK constraint.
 */
export function normaliseVisibility(
  visibility: ResourceVisibility | undefined | null,
  teamId: string | null | undefined,
): { visibility: ResourceVisibility; teamId: string | null } {
  const v: ResourceVisibility = visibility ?? 'org';
  return { visibility: v, teamId: v === 'team' ? (teamId ?? null) : null };
}

/**
 * Options for applyListFilter. `ownerColumn` names the column that holds
 * a private row's owner on this entity; null means the entity has no
 * private tier (approval_requests), so no private clause is emitted.
 */
export interface ListFilterOptions {
  ownerColumn?: 'ownerUserId' | 'createdBy' | null;
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
    // Same rule as the request layer (common/authorization/membership.ts):
    // a row that still holds an invite token has not been accepted and is
    // not a membership yet.
    return isEffectiveMembership(row) ? (row?.role ?? null) : null;
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
   * org-wide and private resources don't need the check (private is
   * always the caller's own; the service stamps the owner).
   */
  async assertCanScopeToTeam(
    userId: string,
    organizationId: string,
    visibility: ResourceVisibility | undefined | null,
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
   * the full policy:
   *   - private resources: the owner may do anything; nobody else may
   *     do anything, org owners/admins included
   *   - org owner/admin pass everything else inside their org
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

    // Default visibility for not-yet-migrated entities is 'org'.
    const visibility = resource.visibility ?? 'org';

    // Private is decided before the admin bypass: an admin reaching into
    // a member's "just me" runner or credential is exactly the leak the
    // tier exists to prevent. A private row with no recorded owner is
    // nobody's, so it is refused to everyone rather than opened up.
    if (visibility === 'private') {
      const owner = resourceOwnerId(resource);
      if (owner && owner === user.id) return allow('owner of private resource');
      return deny('private resource belongs to another user');
    }

    if (orgRole === OrganizationRole.OWNER || orgRole === OrganizationRole.ADMIN) {
      return allow('org owner/admin bypass');
    }

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
   * In-memory twin of applyListFilter, for surfaces that already hold
   * the rows (a gateway's tool list, an MCP catalog, a picker built from
   * several sources). Resolves the caller's role and teams once and
   * keeps only rows canAccess(user, row, 'read') would allow.
   */
  async filterVisible<T extends ResourceLike>(
    user: { id: string },
    organizationId: string,
    rows: T[],
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const orgRole = await this.getOrgRole(user.id, organizationId);
    if (!orgRole) return [];
    const isAdmin = orgRole === OrganizationRole.OWNER || orgRole === OrganizationRole.ADMIN;
    const teams = isAdmin ? new Map<string, TeamRole>() : await this.getTeamMemberships(user.id, organizationId);
    return rows.filter((row) => {
      if (row.organizationId !== organizationId) return false;
      const visibility = row.visibility ?? 'org';
      if (visibility === 'private') {
        const owner = resourceOwnerId(row);
        return !!owner && owner === user.id;
      }
      if (isAdmin || visibility === 'org') return true;
      return !!row.teamId && teams.has(row.teamId);
    });
  }

  /**
   * Apply the list-filter for a query builder. Adds a clause:
   *   (alias.visibility = 'org' AND alias.organizationId = :orgId)
   *   OR
   *   (alias.teamId IN (:userTeamIds))
   *   OR
   *   (alias.visibility = 'private' AND alias.<ownerColumn> = :me)
   *
   * Org owners/admins bypass the org/team part (full visibility within
   * their org) but NOT the private part: another member's private row is
   * excluded for them too. `options.ownerColumn` names the owner column
   * for this entity; when it is null (the default) no private row is
   * returned to anyone, which is the safe failure for a caller that
   * forgot to pass it. Returns a small object describing what was
   * applied so the caller can introspect during tests.
   */
  async applyListFilter<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    user: { id: string },
    organizationId: string,
    alias: string,
    options: ListFilterOptions = {},
  ): Promise<{ bypass: boolean; teamIds: string[] }> {
    const orgRole = await this.getOrgRole(user.id, organizationId);
    // A non-member is denied, not merely filtered. Falling through to
    // the org-visibility clause below returned every org-visible row of
    // an organization the caller has no membership in -- canAccess
    // already refuses this case, and a list must refuse it the same way.
    if (!orgRole) {
      throw new ForbiddenException('You are not a member of this organization');
    }
    const ownerColumn = options.ownerColumn ?? null;
    const ownPrivate = ownerColumn
      ? `(${alias}."visibility" = 'private' AND ${alias}."${ownerColumn}" = :_privateOwnerId)`
      : null;
    if (orgRole === OrganizationRole.OWNER || orgRole === OrganizationRole.ADMIN) {
      // Bypass: caller sees every non-private row in the org, plus their own private ones.
      qb.andWhere(`${alias}."organizationId" = :_orgId`, { _orgId: organizationId });
      qb.andWhere(new Brackets((sub) => {
        sub.where(`(${alias}."visibility" IS NULL OR ${alias}."visibility" <> 'private')`);
        if (ownPrivate) sub.orWhere(ownPrivate, { _privateOwnerId: user.id });
      }));
      return { bypass: true, teamIds: [] };
    }
    const memberships = await this.getTeamMemberships(user.id, organizationId);
    const teamIds = Array.from(memberships.keys());
    qb.andWhere(`${alias}."organizationId" = :_orgId`, { _orgId: organizationId });
    qb.andWhere(new Brackets((sub) => {
      sub.where(`(${alias}."visibility" IS NULL OR ${alias}."visibility" = 'org')`);
      if (teamIds.length > 0) {
        sub.orWhere(`(${alias}."visibility" = 'team' AND ${alias}."teamId" IN (:...userTeamIds))`, { userTeamIds: teamIds });
      }
      if (ownPrivate) sub.orWhere(ownPrivate, { _privateOwnerId: user.id });
    }));
    return { bypass: false, teamIds };
  }

  /**
   * Find-options twin of applyListFilter, for repository `count` / `find`
   * calls: `base` repeated once per tier the caller may see, which TypeORM
   * ORs together. Same rules as the list filter -- an org owner/admin gets
   * every non-private row, a member gets org rows plus their teams' rows,
   * and everyone gets their own private rows and nobody else's. A
   * non-member is refused rather than handed the org-wide rows.
   *
   * Use it wherever a count or a "first X" reaches a user: a total that
   * includes another member's private rows tells the caller those rows
   * exist.
   */
  async visibleWhere<T extends ObjectLiteral>(
    user: { id: string },
    organizationId: string,
    base: FindOptionsWhere<T>,
    options: ListFilterOptions = {},
  ): Promise<FindOptionsWhere<T>[]> {
    const orgRole = await this.getOrgRole(user.id, organizationId);
    if (!orgRole) {
      throw new ForbiddenException('You are not a member of this organization');
    }
    const scoped: Record<string, unknown> = { ...base, organizationId };
    const tiers: Record<string, unknown>[] = [];
    if (orgRole === OrganizationRole.OWNER || orgRole === OrganizationRole.ADMIN) {
      tiers.push({ ...scoped, visibility: Not('private') });
    } else {
      tiers.push({ ...scoped, visibility: 'org' });
      const teamIds = Array.from((await this.getTeamMemberships(user.id, organizationId)).keys());
      if (teamIds.length > 0) tiers.push({ ...scoped, visibility: 'team', teamId: In(teamIds) });
    }
    const ownerColumn = options.ownerColumn ?? null;
    if (ownerColumn) tiers.push({ ...scoped, visibility: 'private', [ownerColumn]: user.id });
    return tiers as FindOptionsWhere<T>[];
  }
}

function allow(reason: string): AccessDecision {
  return { allowed: true, reason };
}
function deny(reason: string): AccessDecision {
  return { allowed: false, reason };
}
