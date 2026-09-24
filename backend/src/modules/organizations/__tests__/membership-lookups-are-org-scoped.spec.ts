import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { OrganizationsService } from '../organizations.service';
import { OrganizationRole, UserOrganization } from '../../../entities/user-organization.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';

/**
 * Every membership lookup in OrganizationsService names the organization,
 * and `organizations.service.spec.ts` answers all of them from
 * `findOne.mockResolvedValue(...)`, whatever the `where`. So nothing there
 * proved that an owner of org B is not treated as an owner of org A.
 *
 * Here the membership table is real: each user holds a row in ONE org,
 * and the service is asked about the other.
 */
describe('OrganizationsService membership lookups are organization-scoped', () => {
  const HERE = 'org-1';
  const ELSEWHERE = 'org-2';

  const membership = (over: Partial<UserOrganization>): Partial<UserOrganization> => ({
    id: `uo-${over.userId}-${over.organizationId ?? HERE}`,
    organizationId: HERE,
    role: OrganizationRole.MEMBER,
    isActive: true,
    inviteAccepted: true,
    joinedAt: new Date(),
    user: { id: over.userId, email: `${over.userId}@example.com` } as any,
    ...over,
  });

  function build(memberships: Array<Partial<UserOrganization>> = []) {
    const userOrganizations = fakeRepository<any>({
      seed: memberships,
      make: () => new UserOrganization(),
    });
    const teams = fakeRepository<any>([
      { id: 'team-A', name: 'Team A', organizationId: HERE, isDefault: false, isActive: true },
    ]);

    const service = new OrganizationsService(
      fakeRepository<any>() as any,
      userOrganizations as any,
      teams as any,
      fakeRepository<any>() as any,
      fakeRepository<any>() as any,
      {} as any,
      {} as any,
      {} as any,
      { joinDefaultTeam: jest.fn() } as any,
      undefined,
      undefined,
      undefined,
      // Removal hands the member's private resources over in the same
      // transaction; that is covered by its own spec.
      { handOverPrivateResources: jest.fn().mockResolvedValue([]) } as any,
      { publishCommitted: jest.fn() } as any,
    );
    fakeManager([[UserOrganization, userOrganizations]]);

    return { service, userOrganizations, teams };
  }

  it('getMembers lists the org for a member of it', async () => {
    const { service } = build([membership({ userId: 'member' })]);

    await expect(service.getMembers(HERE, 'member')).resolves.toHaveLength(1);
  });

  it('getMembers refuses a caller whose membership is in another organization', async () => {
    const { service } = build([membership({ userId: 'outsider', organizationId: ELSEWHERE })]);

    await expect(service.getMembers(HERE, 'outsider')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('removeMember refuses an actor whose membership is in another organization', async () => {
    const { service, userOrganizations } = build([
      membership({ userId: 'victim' }),
      membership({ userId: 'outsider', organizationId: ELSEWHERE, role: OrganizationRole.OWNER }),
    ]);

    await expect(service.removeMember(HERE, 'victim', 'outsider')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(userOrganizations.rows()).toHaveLength(2);
  });

  it('removeMember does not evict a membership held in another organization', async () => {
    const { service, userOrganizations } = build([
      membership({ userId: 'admin-1', role: OrganizationRole.ADMIN }),
      membership({ userId: 'theirs', organizationId: ELSEWHERE }),
    ]);

    await expect(service.removeMember(HERE, 'theirs', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(userOrganizations.rows()).toHaveLength(2);
  });

  it('removeMember evicts a member of the org', async () => {
    const { service, userOrganizations } = build([
      membership({ userId: 'admin-1', role: OrganizationRole.ADMIN }),
      membership({ userId: 'member' }),
    ]);

    await service.removeMember(HERE, 'member', 'admin-1');

    expect(userOrganizations.rows().map((r) => r.userId)).toEqual(['admin-1']);
  });

  it('updateMemberRole refuses an actor whose membership is in another organization', async () => {
    const { service, userOrganizations } = build([
      membership({ userId: 'victim' }),
      membership({ userId: 'outsider', organizationId: ELSEWHERE, role: OrganizationRole.OWNER }),
    ]);

    await expect(
      service.updateMemberRole(HERE, 'victim', OrganizationRole.ADMIN, 'outsider'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(userOrganizations.row(`uo-victim-${HERE}`)!.role).toBe(OrganizationRole.MEMBER);
  });

  it('updateMemberRole does not rewrite a membership held in another organization', async () => {
    const { service, userOrganizations } = build([
      membership({ userId: 'owner-1', role: OrganizationRole.OWNER }),
      membership({ userId: 'theirs', organizationId: ELSEWHERE }),
    ]);

    await expect(
      service.updateMemberRole(HERE, 'theirs', OrganizationRole.ADMIN, 'owner-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(userOrganizations.row(`uo-theirs-${ELSEWHERE}`)!.role).toBe(OrganizationRole.MEMBER);
  });

  it('updateMemberRole writes the stored row for a member of the org', async () => {
    const { service, userOrganizations } = build([
      membership({ userId: 'owner-1', role: OrganizationRole.OWNER }),
      membership({ userId: 'member' }),
    ]);

    await service.updateMemberRole(HERE, 'member', OrganizationRole.ADMIN, 'owner-1');

    expect(userOrganizations.row(`uo-member-${HERE}`)!.role).toBe(OrganizationRole.ADMIN);
  });

  it('team management does not treat an owner of another organization as an org admin', async () => {
    const { service, teams } = build([
      membership({ userId: 'owner-elsewhere', organizationId: ELSEWHERE, role: OrganizationRole.OWNER }),
    ]);

    await expect(
      service.updateTeam(HERE, 'team-A', { name: 'Renamed' }, 'owner-elsewhere'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(teams.row('team-A')!.name).toBe('Team A');
  });

  it('addTeamMember refuses a user whose membership is in another organization', async () => {
    const { service } = build([membership({ userId: 'theirs', organizationId: ELSEWHERE })]);

    await expect(service.addTeamMember(HERE, 'team-A', 'theirs')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('userHasRole and userHasPermission do not read a membership from another organization', async () => {
    const { service } = build([
      membership({ userId: 'user-1', organizationId: ELSEWHERE, role: OrganizationRole.OWNER }),
    ]);

    await expect(service.userHasRole('user-1', HERE, [OrganizationRole.OWNER])).resolves.toBe(false);
    await expect(service.userHasPermission('user-1', HERE, 'billing')).resolves.toBe(false);
    await expect(service.userHasRole('user-1', ELSEWHERE, [OrganizationRole.OWNER])).resolves.toBe(true);
  });
});
