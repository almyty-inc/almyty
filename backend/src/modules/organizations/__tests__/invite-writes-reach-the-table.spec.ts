import { NotFoundException } from '@nestjs/common';

import { OrganizationRole, UserOrganization } from '../../../entities/user-organization.entity';
import { OrganizationsInvitesHelper } from '../organizations-invites.helper';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';

/**
 * Accepting and revoking a membership invite are writes to one
 * `user_organizations` row. The listing and permissions specs hand the
 * helper an object from `findOne.mockResolvedValue(...)` and then read
 * that same object back, so the `save` was never needed for them to pass,
 * and the revoke lookup's `organizationId` was never evaluated. Here the
 * table is real: what counts is the stored row.
 */
describe('OrganizationsInvitesHelper membership-invite writes', () => {
  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const future = () => new Date(Date.now() + 7 * 86_400_000);

  let helper: OrganizationsInvitesHelper;
  let memberships: FakeRepository<any>;

  const invite = (over: Record<string, unknown> = {}) => ({
    id: 'm-1',
    userId: 'invitee',
    organizationId: ORG,
    role: OrganizationRole.MEMBER,
    isActive: true,
    inviteAccepted: false,
    inviteToken: 'tok-1',
    inviteExpiresAt: future(),
    ...over,
  });

  function build(rows: any[]) {
    memberships = fakeRepository<any>({ seed: rows, make: () => new UserOrganization() });
    const users = fakeRepository<any>([
      { id: 'invitee', email: 'invitee@example.com' },
      { id: 'someone-else', email: 'else@example.com' },
    ]);
    helper = new OrganizationsInvitesHelper(
      fakeRepository<any>() as any,
      memberships as any,
      users as any,
      {} as any,
      {} as any,
      { joinDefaultTeam: jest.fn() } as any,
    );
  }

  describe('acceptInvite', () => {
    it('records the acceptance on the stored row and spends the token', async () => {
      build([invite()]);

      await helper.acceptInvite('tok-1', 'invitee');

      expect(memberships.row('m-1')).toMatchObject({ inviteAccepted: true, inviteToken: null });
    });

    it('does not let somebody else accept it', async () => {
      build([invite()]);

      await expect(helper.acceptInvite('tok-1', 'someone-else')).rejects.toBeInstanceOf(NotFoundException);
      expect(memberships.row('m-1')).toMatchObject({ inviteAccepted: false, inviteToken: 'tok-1' });
    });
  });

  describe('revokePendingInvite', () => {
    it('deactivates the stored row and clears its token', async () => {
      build([invite()]);

      await helper.revokePendingInvite(ORG, 'mem:m-1');

      expect(memberships.row('m-1')).toMatchObject({
        isActive: false,
        inviteToken: null,
        inviteExpiresAt: null,
      });
    });

    it("does not revoke another organization's invite", async () => {
      build([invite({ organizationId: OTHER_ORG })]);

      await expect(helper.revokePendingInvite(ORG, 'mem:m-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(memberships.row('m-1')).toMatchObject({ isActive: true, inviteToken: 'tok-1' });
    });

    it('does not deactivate a membership whose invite was already accepted', async () => {
      build([invite({ inviteAccepted: true, inviteToken: null })]);

      await expect(helper.revokePendingInvite(ORG, 'mem:m-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(memberships.row('m-1')!.isActive).toBe(true);
    });
  });
});
