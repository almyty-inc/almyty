import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { OrganizationsService } from '../organizations.service';
import { OrganizationRole, UserOrganization } from '../../../entities/user-organization.entity';
import { Team } from '../../../entities/team.entity';
// Shared tenancy fixture. It lives under credentials/__tests__ only
// because that is the module this audit started in; it is not specific
// to credentials and would sit more naturally in src/test/.
import { makeOrgScopedRepo } from '../../credentials/__tests__/org-scoped-repo.fixtures';

/**
 * Every membership lookup in OrganizationsService is
 * `where: { userId, organizationId, isActive: true }`, and
 * `organizations.service.spec.ts` drives all of them through
 * `userOrganizationRepository.findOne.mockResolvedValue(...)` -- a
 * double that hands its canned membership back whatever `where` it is
 * given. No test in that suite asserts the arguments, so deleting
 * `organizationId` from getMembers, removeMember, updateMemberRole,
 * assertCanManageTeam, userHasRole and userHasPermission left the whole
 * module green: an owner of org B would have been treated as an owner
 * of org A everywhere those lookups gate.
 *
 * These tests drive the same paths through a repository that evaluates
 * its criteria.
 */
describe('OrganizationsService membership lookups are organization-scoped', () => {
  const HERE = 'org-1';
  const ELSEWHERE = 'org-2';

  const membership = (over: Partial<UserOrganization>): UserOrganization =>
    Object.assign(new UserOrganization(), {
      id: `uo-${over.userId}-${over.organizationId}`,
      userId: 'user-1',
      organizationId: HERE,
      role: OrganizationRole.MEMBER,
      isActive: true,
      inviteAccepted: true,
      joinedAt: new Date(),
      hasPermission: () => true,
      ...over,
    });

  function build(memberships: UserOrganization[] = [], teams: Team[] = []) {
    const organizationRepo = makeOrgScopedRepo<any>([]);
    const userOrganizationRepo = makeOrgScopedRepo<UserOrganization>(memberships);
    const teamRepo = makeOrgScopedRepo<Team>(teams);
    const userTeamRepo = makeOrgScopedRepo<any>([]);
    const userRepo = makeOrgScopedRepo<any>([]);

    const service = new OrganizationsService(
      organizationRepo as any,
      userOrganizationRepo as any,
      teamRepo as any,
      userTeamRepo as any,
      userRepo as any,
      { sendInvitation: jest.fn() } as any,
      { ensureSystemGateway: jest.fn() } as any,
      {} as any,
      { joinDefaultTeam: jest.fn() } as any,
    );

    return { service, userOrganizationRepo, teamRepo };
  }

  it('getMembers refuses a caller whose membership is in another organization', async () => {
    const { service } = build([membership({ userId: 'outsider', organizationId: ELSEWHERE })]);

    await expect(service.getMembers(HERE, 'outsider')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('removeMember refuses an actor whose membership is in another organization', async () => {
    const { service, userOrganizationRepo } = build([
      membership({ userId: 'victim', organizationId: HERE }),
      membership({ userId: 'outsider', organizationId: ELSEWHERE, role: OrganizationRole.OWNER }),
    ]);

    await expect(service.removeMember(HERE, 'victim', 'outsider')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(userOrganizationRepo.rows).toHaveLength(2);
  });

  it('removeMember will not evict a membership held in another organization', async () => {
    const { service, userOrganizationRepo } = build([
      membership({ userId: 'admin-1', organizationId: HERE, role: OrganizationRole.ADMIN }),
      membership({ userId: 'theirs', organizationId: ELSEWHERE }),
    ]);

    await expect(service.removeMember(HERE, 'theirs', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(userOrganizationRepo.rows).toHaveLength(2);
  });

  it('updateMemberRole refuses an actor whose membership is in another organization', async () => {
    const { service, userOrganizationRepo } = build([
      membership({ userId: 'victim', organizationId: HERE }),
      membership({ userId: 'outsider', organizationId: ELSEWHERE, role: OrganizationRole.OWNER }),
    ]);

    await expect(
      service.updateMemberRole(HERE, 'victim', OrganizationRole.ADMIN, 'outsider'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      userOrganizationRepo.rows.find((r) => r.userId === 'victim')!.role,
    ).toBe(OrganizationRole.MEMBER);
  });

  it('team management does not treat an owner of another organization as an org admin', async () => {
    const team = Object.assign(new Team(), {
      id: 'team-A',
      name: 'Team A',
      organizationId: HERE,
      isDefault: false,
      isActive: true,
    });
    const { service } = build(
      [membership({ userId: 'owner-elsewhere', organizationId: ELSEWHERE, role: OrganizationRole.OWNER })],
      [team],
    );

    await expect(
      service.updateTeam(HERE, 'team-A', { name: 'Renamed' }, 'owner-elsewhere'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('userHasRole and userHasPermission do not read a membership from another organization', async () => {
    const { service } = build([
      membership({ userId: 'user-1', organizationId: ELSEWHERE, role: OrganizationRole.OWNER }),
    ]);

    await expect(service.userHasRole('user-1', HERE, [OrganizationRole.OWNER])).resolves.toBe(
      false,
    );
    await expect(service.userHasPermission('user-1', HERE, 'billing')).resolves.toBe(false);
  });
});
