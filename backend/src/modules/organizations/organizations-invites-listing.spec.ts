import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException, forwardRef } from '@nestjs/common';
import * as crypto from 'crypto';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { MailService } from '../mail/mail.service';
import { GatewaysService } from '../gateways/gateways.service';
import { OrganizationsInvitesHelper } from './organizations-invites.helper';
import { TeamMembershipHelper } from './team-membership.helper';

describe('OrganizationsInvitesHelper — listing + revocation', () => {
  let helper: OrganizationsInvitesHelper;
  let organizationRepository: any;
  let userOrganizationRepository: any;

  const futureExpiry = new Date(Date.now() + 7 * 86_400_000);
  const pastExpiry = new Date(Date.now() - 86_400_000);
  const settingsToken = 'pending-token-abc-xyz';
  const settingsHash = crypto.createHash('sha256').update(settingsToken).digest('hex').slice(0, 16);

  beforeEach(async () => {
    organizationRepository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };

    userOrganizationRepository = {
      createQueryBuilder: jest.fn(() => ({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'membership-uuid-1',
            role: 'member',
            invitedBy: 'inviter-1',
            inviteToken: 'tok-member-1',
            inviteExpiresAt: futureExpiry,
            user: { email: 'existing@example.com' },
          },
        ]),
      })),
      findOne: jest.fn(),
      save: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsInvitesHelper,
        { provide: getRepositoryToken(Organization), useValue: organizationRepository },
        { provide: getRepositoryToken(UserOrganization), useValue: userOrganizationRepository },
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
        { provide: MailService, useValue: { sendInvitation: jest.fn().mockResolvedValue(true) } },
        { provide: GatewaysService, useValue: {} },
        { provide: TeamMembershipHelper, useValue: { joinDefaultTeam: jest.fn() } },
      ],
    }).compile();

    helper = module.get(OrganizationsInvitesHelper);
  });

  describe('listPendingInvites', () => {
    it('aggregates membership invites and settings.pendingInvites without leaking tokens', async () => {
      organizationRepository.findOne.mockResolvedValueOnce({
        id: 'org-1',
        settings: {
          pendingInvites: [
            {
              email: 'newuser@example.com',
              role: 'admin',
              invitedBy: 'inviter-2',
              inviteToken: settingsToken,
              inviteExpiresAt: futureExpiry.toISOString(),
            },
          ],
        },
      });

      const result = await helper.listPendingInvites('org-1');

      expect(result).toHaveLength(2);
      const member = result.find((r) => r.source === 'membership')!;
      const settings = result.find((r) => r.source === 'settings')!;

      expect(member.email).toBe('existing@example.com');
      expect(member.id).toBe('mem:membership-uuid-1');
      expect(member.isExpired).toBe(false);

      expect(settings.email).toBe('newuser@example.com');
      expect(settings.id).toBe(`set:${settingsHash}`);
      expect(settings.isExpired).toBe(false);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(settingsToken);
      expect(serialized).not.toContain('tok-member-1');
    });

    it('marks invites past inviteExpiresAt as isExpired=true', async () => {
      userOrganizationRepository.createQueryBuilder = jest.fn(() => ({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: 'membership-uuid-2',
            role: 'member',
            invitedBy: 'inviter-1',
            inviteToken: 'tok-expired',
            inviteExpiresAt: pastExpiry,
            user: { email: 'expired@example.com' },
          },
        ]),
      }));
      organizationRepository.findOne.mockResolvedValueOnce({ id: 'org-1', settings: {} });

      const result = await helper.listPendingInvites('org-1');
      expect(result[0].isExpired).toBe(true);
    });
  });

  describe('revokePendingInvite', () => {
    it('rejects an invite id without the mem: or set: prefix', async () => {
      await expect(helper.revokePendingInvite('org-1', 'not-prefixed')).rejects.toThrow(BadRequestException);
      await expect(helper.revokePendingInvite('org-1', '')).rejects.toThrow(BadRequestException);
    });

    it('clears token + deactivates membership for mem: id', async () => {
      const membership: any = {
        id: 'membership-uuid-1',
        organizationId: 'org-1',
        inviteAccepted: false,
        inviteToken: 'tok-member-1',
        inviteExpiresAt: futureExpiry,
        isActive: true,
      };
      userOrganizationRepository.findOne.mockResolvedValueOnce(membership);
      userOrganizationRepository.save.mockResolvedValueOnce(membership);

      const result = await helper.revokePendingInvite('org-1', 'mem:membership-uuid-1');

      expect(result.revoked).toBe(true);
      expect(membership.inviteToken).toBeNull();
      expect(membership.inviteExpiresAt).toBeNull();
      expect(membership.isActive).toBe(false);
    });

    it('throws NotFoundException when the mem: id does not match', async () => {
      userOrganizationRepository.findOne.mockResolvedValueOnce(null);
      await expect(helper.revokePendingInvite('org-1', 'mem:does-not-exist')).rejects.toThrow(NotFoundException);
    });

    it('removes the matching settings.pendingInvites entry for set: id', async () => {
      const org: any = {
        id: 'org-1',
        settings: {
          pendingInvites: [
            { email: 'a@example.com', role: 'member', inviteToken: settingsToken, inviteExpiresAt: futureExpiry.toISOString() },
            { email: 'b@example.com', role: 'admin', inviteToken: 'other-token', inviteExpiresAt: futureExpiry.toISOString() },
          ],
        },
      };
      organizationRepository.findOne.mockResolvedValueOnce(org);

      const result = await helper.revokePendingInvite('org-1', `set:${settingsHash}`);

      expect(result.revoked).toBe(true);
      expect(organizationRepository.update).toHaveBeenCalledWith('org-1', {
        settings: {
          pendingInvites: [
            { email: 'b@example.com', role: 'admin', inviteToken: 'other-token', inviteExpiresAt: futureExpiry.toISOString() },
          ],
        },
      });
    });

    it('throws NotFoundException when no settings invite matches the hash', async () => {
      organizationRepository.findOne.mockResolvedValueOnce({
        id: 'org-1',
        settings: { pendingInvites: [] },
      });
      await expect(helper.revokePendingInvite('org-1', 'set:0000000000000000')).rejects.toThrow(NotFoundException);
    });
  });
});
