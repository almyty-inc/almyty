import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';

import { Organization } from '../../../entities/organization.entity';
import { User } from '../../../entities/user.entity';
import { OrganizationRole, UserOrganization } from '../../../entities/user-organization.entity';
import { MailService } from '../../mail/mail.service';
import { GatewaysService } from '../../gateways/gateways.service';
import { OrganizationsInvitesHelper } from '../organizations-invites.helper';
import { TeamMembershipHelper } from '../team-membership.helper';

/**
 * `InviteUserDto.permissions` was accepted, validated and documented,
 * and then dropped: nothing in the backend ever wrote
 * `user_organizations.permissions`, even though
 * UserOrganization.hasPermission() and the connections permission check
 * both read it. An owner granting an invitee `connections:manage` got a
 * 200 and a membership without it.
 *
 * It is also additive to the role, so it can only be granted down from
 * what the inviter holds.
 */
describe('OrganizationsInvitesHelper - invite permissions', () => {
  let helper: OrganizationsInvitesHelper;
  let organizationRepository: any;
  let userOrganizationRepository: any;
  let userRepository: any;

  const membership = (role: OrganizationRole, extra: Partial<UserOrganization> = {}) =>
    Object.assign(new UserOrganization(), {
      id: 'uo-inviter',
      userId: 'inviter-1',
      organizationId: 'org-1',
      role,
      isActive: true,
      inviteAccepted: true,
      ...extra,
    });

  beforeEach(async () => {
    organizationRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Acme', settings: {} }),
      query: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };
    userOrganizationRepository = {
      findOne: jest.fn(),
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn(async (m: any) => m),
    };
    userRepository = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsInvitesHelper,
        { provide: getRepositoryToken(Organization), useValue: organizationRepository },
        { provide: getRepositoryToken(UserOrganization), useValue: userOrganizationRepository },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: MailService, useValue: { sendInvitation: jest.fn().mockResolvedValue(true) } },
        { provide: GatewaysService, useValue: {} },
        { provide: TeamMembershipHelper, useValue: { joinDefaultTeam: jest.fn() } },
      ],
    }).compile();

    helper = module.get(OrganizationsInvitesHelper);
  });

  describe('existing user', () => {
    beforeEach(() => {
      // inviter membership lookup, then the "already a member?" lookup.
      userOrganizationRepository.findOne
        .mockResolvedValueOnce(membership(OrganizationRole.OWNER))
        .mockResolvedValueOnce(null);
      // Resolved by argument rather than by call order: the helper looks
      // the invitee up by email and the inviter up by id.
      userRepository.findOne.mockImplementation(async ({ where }: any) =>
        where.id ? { id: 'inviter-1', firstName: 'Ada', lastName: 'L' } : { id: 'user-2', email: 'bob@example.com' },
      );
    });

    it('persists the granted permissions onto the new membership row', async () => {
      await helper.inviteUser(
        'org-1',
        { email: 'bob@example.com', role: OrganizationRole.MEMBER, permissions: ['connections:manage'] },
        'inviter-1',
      );

      expect(userOrganizationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-2', permissions: ['connections:manage'] }),
      );
      const saved = userOrganizationRepository.save.mock.calls[0][0];
      expect(saved.permissions).toEqual(['connections:manage']);
    });

    it('trims and de-duplicates, and drops non-strings', async () => {
      await helper.inviteUser(
        'org-1',
        {
          email: 'bob@example.com',
          role: OrganizationRole.MEMBER,
          permissions: [' connections:read ', 'connections:read', '', 7 as any],
        },
        'inviter-1',
      );

      expect(userOrganizationRepository.save.mock.calls[0][0].permissions).toEqual(['connections:read']);
    });

    it('leaves the column alone when the field is omitted', async () => {
      await helper.inviteUser(
        'org-1',
        { email: 'bob@example.com', role: OrganizationRole.MEMBER },
        'inviter-1',
      );

      expect(userOrganizationRepository.save.mock.calls[0][0].permissions).toBeUndefined();
    });

    it('refuses a permission the inviter does not hold', async () => {
      // ADMIN's role grants do not include 'billing'.
      userOrganizationRepository.findOne.mockReset();
      userOrganizationRepository.findOne
        .mockResolvedValueOnce(membership(OrganizationRole.ADMIN))
        .mockResolvedValueOnce(null);

      await expect(
        helper.inviteUser(
          'org-1',
          { email: 'bob@example.com', role: OrganizationRole.MEMBER, permissions: ['billing'] },
          'inviter-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(userOrganizationRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('new user (pending invite)', () => {
    beforeEach(() => {
      userOrganizationRepository.findOne.mockResolvedValueOnce(membership(OrganizationRole.OWNER));
      userRepository.findOne.mockImplementation(async ({ where }: any) =>
        where.id ? { id: 'inviter-1', firstName: 'Ada', lastName: 'L' } : null,
      );
    });

    it('carries the permissions into the stored pending invite', async () => {
      await helper.inviteUser(
        'org-1',
        { email: 'newcomer@example.com', role: OrganizationRole.MEMBER, permissions: ['connections:manage'] },
        'inviter-1',
      );

      const [, params] = organizationRepository.query.mock.calls[0];
      const stored = JSON.parse(params[1]);
      expect(stored[0].permissions).toEqual(['connections:manage']);
    });
  });

  describe('accepting a pending invite', () => {
    it('applies the invite permissions to the membership it creates', async () => {
      const futureExpiry = new Date(Date.now() + 86_400_000).toISOString();
      organizationRepository.createQueryBuilder = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'org-1',
            name: 'Acme',
            settings: {
              pendingInvites: [
                {
                  email: 'newcomer@example.com',
                  role: 'member',
                  inviteToken: 'tok-1',
                  inviteExpiresAt: futureExpiry,
                  invitedBy: 'inviter-1',
                  permissions: ['connections:manage'],
                },
              ],
            },
          },
        ]),
      }));
      userOrganizationRepository.findOne.mockResolvedValue(null);
      userRepository.findOne.mockResolvedValue({ id: 'user-3', email: 'newcomer@example.com' });

      await helper.acceptInvite('tok-1', 'user-3');

      expect(userOrganizationRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ permissions: ['connections:manage'] }),
      );
    });
  });
});
