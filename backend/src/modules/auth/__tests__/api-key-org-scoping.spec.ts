import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';

import { AuthService } from '../auth.service';
import { CaptchaService } from '../captcha.service';
import { ApiKey } from '../../../entities/api-key.entity';
import { Organization } from '../../../entities/organization.entity';
import { User } from '../../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../../entities/user-organization.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { MailService } from '../../mail/mail.service';
import { ReferralsService } from '../../referrals/referrals.service';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';

/**
 * An API key is stamped with an organization, and `ApiKeyStrategy` sets
 * `currentOrganizationId` from that stamp. Two predicates decide what may
 * be stamped and who may unstamp:
 *
 *   createApiKey: the caller must be a member of the org -- by
 *                 `isEffectiveMembership`, the predicate JwtStrategy and
 *                 ApiKeyStrategy use, so a pending or revoked invite is not
 *                 enough.
 *   revokeApiKey: `where: { id, userId }` -- only the user who minted a key
 *                 can revoke it.
 *
 * `auth.service.spec.ts` resolves canned rows from `findOne` whatever the
 * `where` says, so neither predicate was evaluated there. These
 * repositories keep tables and evaluate their criteria.
 */
describe('api key organization scoping', () => {
  const OWNER = 'user-owner';
  const OUTSIDER = 'user-outsider';
  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';

  let service: AuthService;
  let apiKeys: FakeRepository<any>;
  let memberships: FakeRepository<any>;

  /** Joined directly, no invite involved. */
  const realMembership = (overrides: Record<string, unknown> = {}) => ({
    id: 'm-real',
    userId: OWNER,
    organizationId: ORG,
    role: OrganizationRole.OWNER,
    isActive: true,
    inviteAccepted: true,
    inviteToken: null,
    ...overrides,
  });

  /** What `inviteUser` writes: active, unaccepted, token still held. */
  const pendingInvite = (overrides: Record<string, unknown> = {}) => ({
    id: 'm-pending',
    userId: OWNER,
    organizationId: ORG,
    role: OrganizationRole.ADMIN,
    isActive: true,
    inviteAccepted: false,
    inviteToken: 'tok-abc',
    ...overrides,
  });

  /** What revoking an invite leaves behind: the row, deactivated. */
  const revokedInvite = (overrides: Record<string, unknown> = {}) => ({
    id: 'm-revoked',
    userId: OWNER,
    organizationId: ORG,
    role: OrganizationRole.ADMIN,
    isActive: false,
    inviteAccepted: false,
    inviteToken: null,
    ...overrides,
  });

  async function build(opts: { memberships?: any[]; apiKeys?: any[] } = {}): Promise<void> {
    apiKeys = fakeRepository<any>({ seed: opts.apiKeys ?? [], idPrefix: 'key' });
    memberships = fakeRepository<any>({ seed: opts.memberships ?? [], idPrefix: 'membership' });
    const users = fakeRepository<any>({
      seed: [
        { id: OWNER, email: 'owner@example.com' },
        { id: OUTSIDER, email: 'outsider@example.com' },
      ],
    });
    // The org default reads the user with its memberships joined; the
    // relation load has no filter, so every row for the user comes back.
    const plainFindOne = users.findOne.getMockImplementation()!;
    users.findOne.mockImplementation(async (options: any) => {
      const user = await plainFindOne(options);
      if (user && options?.relations?.organizationMemberships) {
        user.organizationMemberships = await memberships.find({ where: { userId: user.id } });
      }
      return user;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(ApiKey), useValue: apiKeys },
        { provide: getRepositoryToken(Organization), useValue: fakeRepository<any>() },
        { provide: getRepositoryToken(UserOrganization), useValue: memberships },
        { provide: JwtService, useValue: { sign: jest.fn(), verify: jest.fn() } },
        {
          provide: AuditLogService,
          useValue: { log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn() },
        },
        { provide: MailService, useValue: { send: jest.fn() } },
        { provide: ReferralsService, useValue: { attributeSignup: jest.fn() } },
        {
          provide: CaptchaService,
          useValue: { isEnabled: jest.fn().mockReturnValue(false), verify: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(AuthService);
  }

  describe('revokeApiKey', () => {
    const ownedKey = { id: 'key-1', userId: OWNER, organizationId: ORG, isActive: true };

    it('deactivates the stored row', async () => {
      await build({ apiKeys: [ownedKey] });

      await service.revokeApiKey('key-1', OWNER);

      expect(apiKeys.row('key-1').isActive).toBe(false);
    });

    it("refuses to revoke another user's key and leaves it active", async () => {
      await build({ apiKeys: [ownedKey] });

      await expect(service.revokeApiKey('key-1', OUTSIDER)).rejects.toThrow(BadRequestException);

      expect(apiKeys.row('key-1').isActive).toBe(true);
    });
  });

  describe('createApiKey with an explicit organization', () => {
    it('stamps an org the caller belongs to', async () => {
      await build({ memberships: [realMembership()] });

      const { keyData } = await service.createApiKey(OWNER, { name: 'ci', organizationId: ORG } as any);

      expect(keyData.organizationId).toBe(ORG);
      expect(apiKeys.rows()).toHaveLength(1);
    });

    it('refuses an org the caller has no row for', async () => {
      await build({ memberships: [realMembership()] });

      await expect(
        service.createApiKey(OWNER, { name: 'ci', organizationId: OTHER_ORG } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(apiKeys.rows()).toHaveLength(0);
    });

    it('refuses an org whose invite was revoked', async () => {
      await build({ memberships: [revokedInvite()] });

      await expect(
        service.createApiKey(OWNER, { name: 'ci', organizationId: ORG } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(apiKeys.rows()).toHaveLength(0);
    });

    it('refuses an org whose invite has not been accepted', async () => {
      await build({ memberships: [pendingInvite()] });

      await expect(
        service.createApiKey(OWNER, { name: 'ci', organizationId: ORG } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(apiKeys.rows()).toHaveLength(0);
    });
  });

  describe('createApiKey with no organization asked for', () => {
    it("defaults to the caller's single org", async () => {
      await build({ memberships: [realMembership()] });

      const { keyData } = await service.createApiKey(OWNER, { name: 'cli' } as any);

      expect(keyData.organizationId).toBe(ORG);
    });

    it('leaves the key unscoped when the only row is a pending invite', async () => {
      await build({ memberships: [pendingInvite()] });

      const { keyData } = await service.createApiKey(OWNER, { name: 'cli' } as any);

      expect(keyData.organizationId).toBeUndefined();
    });

    it('leaves the key unscoped when the only row is a revoked invite', async () => {
      await build({ memberships: [revokedInvite()] });

      const { keyData } = await service.createApiKey(OWNER, { name: 'cli' } as any);

      expect(keyData.organizationId).toBeUndefined();
    });

    it('does not default when the caller belongs to two orgs', async () => {
      await build({
        memberships: [realMembership(), realMembership({ id: 'm-real-2', organizationId: OTHER_ORG })],
      });

      const { keyData } = await service.createApiKey(OWNER, { name: 'cli' } as any);

      expect(keyData.organizationId).toBeUndefined();
    });

    it('defaults to the real org when a pending invite sits beside it', async () => {
      await build({
        memberships: [
          realMembership(),
          pendingInvite({ id: 'm-pending-2', organizationId: OTHER_ORG }),
        ],
      });

      const { keyData } = await service.createApiKey(OWNER, { name: 'cli' } as any);

      expect(keyData.organizationId).toBe(ORG);
    });
  });
});
