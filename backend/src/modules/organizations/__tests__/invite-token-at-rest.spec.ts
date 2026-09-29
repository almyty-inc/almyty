import { ConflictException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';

import { OrganizationRole, UserOrganization } from '../../../entities/user-organization.entity';
import { OrganizationsInvitesHelper, hashInviteToken } from '../organizations-invites.helper';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';

/**
 * An invite token is a bearer secret: whoever holds it (and is the
 * addressee) joins the organization. So only its SHA-256 is stored, the
 * raw token goes out in the email and nowhere else, the in-app
 * notification links to the membership row instead, and accepting spends
 * the invite exactly once even when two accepts race.
 */
describe('invite tokens at rest', () => {
  const ORG = 'org-1';
  const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

  let memberships: FakeRepository<any>;
  let orgQuery: jest.Mock;
  let sendInvitation: jest.Mock;
  let emit: jest.Mock;
  let helper: OrganizationsInvitesHelper;

  function build(membershipRows: any[] = []) {
    memberships = fakeRepository<any>({ seed: membershipRows, make: () => new UserOrganization(), idPrefix: 'm' });
    const inviter = Object.assign(new UserOrganization(), {
      id: 'inviter-m',
      userId: 'inviter',
      organizationId: ORG,
      role: OrganizationRole.OWNER,
      isActive: true,
      inviteAccepted: true,
    });
    memberships.seed(inviter);
    const orgs = fakeRepository<any>([{ id: ORG, name: 'Acme', settings: {} }]);
    orgQuery = jest.fn().mockResolvedValue(undefined);
    (orgs as any).query = orgQuery;
    // No pending (settings) invites in these cases.
    (orgs as any).createQueryBuilder = () => ({ where: () => ({ getMany: async () => [] }) });
    const users = fakeRepository<any>([
      { id: 'inviter', email: 'owner@acme.test', firstName: 'O', lastName: 'W' },
      { id: 'invitee', email: 'invitee@example.com', isVerified: true, verifiedAt: new Date() },
    ]);
    sendInvitation = jest.fn().mockResolvedValue(true);
    emit = jest.fn().mockResolvedValue(undefined);
    helper = new OrganizationsInvitesHelper(
      orgs as any,
      memberships as any,
      users as any,
      { sendInvitation } as any,
      {} as any,
      { joinDefaultTeam: jest.fn() } as any,
      { emit } as any,
    );
  }

  it('stores only the hash of the token it mails to an existing account', async () => {
    build();

    await helper.inviteUser(ORG, { email: 'invitee@example.com', role: OrganizationRole.MEMBER } as any, 'inviter');

    const mailed: string = sendInvitation.mock.calls[0][0].inviteToken;
    const row = memberships.rows().find((m) => m.userId === 'invitee');
    expect(row.inviteToken).toBe(sha256(mailed));
    expect(row.inviteToken).not.toBe(mailed);
    expect(hashInviteToken(mailed)).toBe(row.inviteToken);
  });

  it('gives the in-app notification a link that carries no token', async () => {
    build();

    await helper.inviteUser(ORG, { email: 'invitee@example.com', role: OrganizationRole.MEMBER } as any, 'inviter');

    const mailed: string = sendInvitation.mock.calls[0][0].inviteToken;
    const row = memberships.rows().find((m) => m.userId === 'invitee');
    const link: string = emit.mock.calls[0][0].link;
    expect(link).not.toContain(mailed);
    expect(link).not.toContain(encodeURIComponent(mailed));
    expect(link).not.toContain(row.inviteToken);
    expect(link).toBe(`/invite/accept?membership=${row.id}`);
  });

  it('stores only the hash in a pending invite for an address with no account', async () => {
    build();

    await helper.inviteUser(ORG, { email: 'newcomer@example.com', role: OrganizationRole.MEMBER } as any, 'inviter');

    const mailed: string = sendInvitation.mock.calls[0][0].inviteToken;
    const [, params] = orgQuery.mock.calls[0];
    const [pending] = JSON.parse(params[1]);
    expect(pending.inviteToken).toBe(sha256(mailed));
    expect(params[1]).not.toContain(mailed);
  });

  describe('accepting', () => {
    const TOKEN = 'raw-invite-token';
    const pending = (over: Record<string, unknown> = {}) => ({
      id: 'm-1',
      userId: 'invitee',
      organizationId: ORG,
      role: OrganizationRole.MEMBER,
      isActive: true,
      inviteAccepted: false,
      inviteToken: sha256(TOKEN),
      inviteExpiresAt: new Date(Date.now() + 86_400_000),
      ...over,
    });

    it('accepts the mailed token, not the stored hash', async () => {
      build([pending()]);

      await expect(helper.acceptInvite(sha256(TOKEN), 'invitee')).rejects.toBeInstanceOf(NotFoundException);
      await helper.acceptInvite(TOKEN, 'invitee');

      expect(memberships.row('m-1')).toMatchObject({ inviteAccepted: true, inviteToken: null });
    });

    it('lets only one of two concurrent accepts of one token through', async () => {
      build([pending()]);

      const results = await Promise.allSettled([
        helper.acceptInvite(TOKEN, 'invitee'),
        helper.acceptInvite(TOKEN, 'invitee'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);
    });

    it('accepts from the notification link for the invitee only', async () => {
      build([pending()]);

      await expect(helper.acceptInviteForMembership('m-1', 'inviter')).rejects.toBeInstanceOf(NotFoundException);
      expect(memberships.row('m-1')!.inviteAccepted).toBe(false);

      await helper.acceptInviteForMembership('m-1', 'invitee');
      expect(memberships.row('m-1')).toMatchObject({ inviteAccepted: true, inviteToken: null });
      await expect(helper.acceptInviteForMembership('m-1', 'invitee')).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not reopen a revoked invite from the notification link', async () => {
      build([pending({ isActive: false, inviteToken: null, inviteExpiresAt: null })]);

      await expect(helper.acceptInviteForMembership('m-1', 'invitee')).rejects.toBeInstanceOf(NotFoundException);
      expect(memberships.row('m-1')!.inviteAccepted).toBe(false);
    });
  });
});
