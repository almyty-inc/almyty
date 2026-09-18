import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException } from '@nestjs/common';

import { Organization } from '../../../entities/organization.entity';
import { User } from '../../../entities/user.entity';
import { UserOrganization } from '../../../entities/user-organization.entity';
import { MailService } from '../../mail/mail.service';
import { GatewaysService } from '../../gateways/gateways.service';
import { OrganizationsInvitesHelper } from '../organizations-invites.helper';
import { TeamMembershipHelper } from '../team-membership.helper';

/**
 * Accepting an invite must not rewrite the whole org settings column
 * from a snapshot read earlier.
 *
 * It used to filter `pendingInvites` in memory and write
 * `settings: { ...org.settings, pendingInvites: filtered }`. Two
 * invitees accepting different invites at once each wrote their own
 * full array, so A's removal of i1 was undone by B (which had loaded
 * before A wrote) and i1 came back; a second accept of the resurrected
 * token then hit the membership unique index as a 500. An admin
 * editing org settings concurrently lost the edit the same way.
 */
describe('OrganizationsInvitesHelper - accepting an invite', () => {
  let helper: OrganizationsInvitesHelper;
  let organizationRepository: any;
  let userOrganizationRepository: any;

  const TOKEN = 'invite-token-1';
  const EMAIL = 'newcomer@example.com';
  const futureExpiry = new Date(Date.now() + 7 * 86_400_000).toISOString();

  const org = () => ({
    id: 'org-1',
    name: 'Acme',
    settings: {
      // A second pending invite and an unrelated settings key, both of
      // which a whole-column rewrite would carry along from a stale read.
      maxApis: 25,
      pendingInvites: [
        { email: EMAIL, role: 'member', inviteToken: TOKEN, inviteExpiresAt: futureExpiry, invitedBy: 'inviter-1' },
        { email: 'other@example.com', role: 'admin', inviteToken: 'invite-token-2', inviteExpiresAt: futureExpiry },
      ],
    },
  });

  beforeEach(async () => {
    organizationRepository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([org()]),
      })),
    };
    userOrganizationRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn(async (m: any) => m),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsInvitesHelper,
        { provide: getRepositoryToken(Organization), useValue: organizationRepository },
        { provide: getRepositoryToken(UserOrganization), useValue: userOrganizationRepository },
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn().mockResolvedValue({ id: 'user-1', email: EMAIL }) } },
        { provide: MailService, useValue: { sendInvitation: jest.fn().mockResolvedValue(true) } },
        { provide: GatewaysService, useValue: {} },
        { provide: TeamMembershipHelper, useValue: { joinDefaultTeam: jest.fn() } },
      ],
    }).compile();

    helper = module.get(OrganizationsInvitesHelper);
  });

  const accept = () => helper.acceptInvite(TOKEN, 'user-1');

  it('removes only the accepted invite, in the database', async () => {
    const result = await accept();

    expect(result).toEqual({ organizationId: 'org-1', organizationName: 'Acme' });
    // Never a whole-column write from the snapshot.
    expect(organizationRepository.update).not.toHaveBeenCalled();

    const [sql, params] = organizationRepository.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE organizations/);
    // Scoped to the pendingInvites path, so a concurrent settings edit
    // survives, and matched on the token, so a concurrent accept of a
    // different invite is not undone.
    expect(sql).toMatch(/'\{pendingInvites\}'/);
    expect(sql).toMatch(/inviteToken/);
    expect(params).toEqual(['org-1', TOKEN]);
  });

  it('reports a second accept of the same invite as a conflict, not a 500', async () => {
    userOrganizationRepository.save.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    );

    await expect(accept()).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not swallow a membership save failure that is not a unique violation', async () => {
    userOrganizationRepository.save.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(accept()).rejects.toThrow('connection terminated');
  });
});
