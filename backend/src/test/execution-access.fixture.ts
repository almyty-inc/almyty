/**
 * A truthful membership table for specs that exercise the execution gate.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * The decision itself is never faked: specs get the real
 * AccessPolicyService.canAccess and the real ExecutionAccessService. What is
 * in memory is the membership data they read -- `user_organizations` through
 * the truthful fakeRepository, and `user_teams` joined to `teams` by the same
 * predicate the SQL in AccessPolicyService.getTeamMemberships uses (the row's
 * user, `isActive = true`, and a team of the organization asked about). The
 * SQL itself is proven against Postgres in
 * src/test/integration/execution-access.integration.spec.ts.
 */
import { AccessPolicyService } from '../common/authorization/access-policy.service';
import { ExecutionAccessService } from '../common/authorization/execution-access.service';
import { OrganizationRole } from '../entities/user-organization.entity';
import { TeamRole } from '../entities/user-team.entity';
import { fakeRepository } from './fake-repository';

export interface MembershipFixture {
  accessPolicy: AccessPolicyService;
  executionAccess: ExecutionAccessService;
  /** Add an active, accepted organization membership. */
  member(organizationId: string, userId: string, role?: OrganizationRole): void;
  /** Add a team to an organization. */
  team(teamId: string, organizationId: string): void;
  /** Add a team membership; `isActive: false` is a departed member. */
  teamMember(teamId: string, userId: string, opts?: { role?: TeamRole; isActive?: boolean }): void;
  /** Deactivate a team membership, as removing someone from a team does. */
  leaveTeam(teamId: string, userId: string): void;
}

export function membershipFixture(): MembershipFixture {
  const userOrgs = fakeRepository<any>([]);
  const teams: Array<{ id: string; organizationId: string }> = [];
  const userTeams: Array<{ teamId: string; userId: string; role: TeamRole; isActive: boolean }> = [];
  const accessPolicy = new AccessPolicyService(userOrgs as any, {} as any);
  accessPolicy.getTeamMemberships = async (userId: string, organizationId: string) => {
    const out = new Map<string, TeamRole>();
    for (const row of userTeams) {
      if (row.userId !== userId || row.isActive !== true) continue;
      const team = teams.find((t) => t.id === row.teamId);
      if (!team || team.organizationId !== organizationId) continue;
      out.set(row.teamId, row.role);
    }
    return out;
  };
  let seq = 0;
  return {
    accessPolicy,
    executionAccess: new ExecutionAccessService(accessPolicy),
    member(organizationId, userId, role = OrganizationRole.MEMBER) {
      userOrgs.seed({ id: `uo-${++seq}`, organizationId, userId, role, isActive: true, inviteAccepted: true, inviteToken: null });
    },
    team(teamId, organizationId) {
      teams.push({ id: teamId, organizationId });
    },
    teamMember(teamId, userId, opts = {}) {
      userTeams.push({ teamId, userId, role: opts.role ?? TeamRole.MEMBER, isActive: opts.isActive ?? true });
    },
    leaveTeam(teamId, userId) {
      for (const row of userTeams) if (row.teamId === teamId && row.userId === userId) row.isActive = false;
    },
  };
}

/**
 * The real access policy over one organization's members and nothing
 * else (no teams), for specs that only need org roles to be true.
 */
export function orgMembersPolicy(
  organizationId: string,
  members: Record<string, OrganizationRole> = {},
): AccessPolicyService {
  const m = membershipFixture();
  for (const [userId, role] of Object.entries(members)) m.member(organizationId, userId, role);
  return m.accessPolicy;
}

/** Fixed ids for the usual cast, so specs read the same. */
export const CAST = {
  org: '0a000000-0000-4000-8000-000000000001',
  otherOrg: '0a000000-0000-4000-8000-000000000002',
  team: '0b000000-0000-4000-8000-000000000001',
  otherTeam: '0b000000-0000-4000-8000-000000000002',
  /** A plain member of `team`. */
  member: '0c000000-0000-4000-8000-000000000001',
  /** A plain member of the org, in `otherTeam` only. */
  nonMember: '0c000000-0000-4000-8000-000000000002',
  /** An org admin in no team. */
  admin: '0c000000-0000-4000-8000-000000000003',
  /** Owner of the private resources; a plain member in no team. */
  owner: '0c000000-0000-4000-8000-000000000004',
} as const;

/** The usual cast, seeded: org + two teams + the four users above. */
export function castFixture(): MembershipFixture {
  const m = membershipFixture();
  m.team(CAST.team, CAST.org);
  m.team(CAST.otherTeam, CAST.org);
  m.member(CAST.org, CAST.member);
  m.member(CAST.org, CAST.nonMember);
  m.member(CAST.org, CAST.admin, OrganizationRole.ADMIN);
  m.member(CAST.org, CAST.owner);
  m.teamMember(CAST.team, CAST.member);
  m.teamMember(CAST.otherTeam, CAST.nonMember);
  return m;
}
