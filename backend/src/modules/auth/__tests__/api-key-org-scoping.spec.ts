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
import { fakeRepo, FakeRepo } from './repo.fixtures';

/**
 * An API key is stamped with an organization, and `ApiKeyStrategy` sets
 * `currentOrganizationId` from that stamp -- the value every per-request
 * scope check compares against. Two predicates decide what may be stamped
 * and who may unstamp:
 *
 *   createApiKey: the caller must actually belong to the org they ask for.
 *   revokeApiKey: `where: { id, userId }` -- a key is revocable by the
 *                 user who minted it, and nobody else.
 *
 * Neither was provable from `auth.service.spec.ts`. Its `findOne` doubles
 * resolve a canned row whatever the `where` says, so the predicates in the
 * criteria are never evaluated: deleting `userId` from the revoke lookup
 * and `isActive: true` from the membership lookup left that module at
 * `13 passed, 234 total`, green.
 *
 * Here the repositories keep tables and evaluate their criteria, so the
 * predicates are proved by which rows come back rather than by the
 * arguments the call recorded.
 */
describe('api key organization scoping', () => {
  const OWNER = 'user-owner';
  const OUTSIDER = 'user-outsider';
  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';

  let service: AuthService;
  let apiKeys: FakeRepo<any>;
  let users: FakeRepo<any>;
  let memberships: FakeRepo<any>;

  /** A row that grants access: joined directly, no invite involved. */
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

  /** What `revokePendingInvite` leaves behind: the row, deactivated. */
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

  async function build(opts: {
    memberships?: any[];
    apiKeys?: any[];
  } = {}): Promise<void> {
    apiKeys = fakeRepo<any>(opts.apiKeys ?? [], 'key');
    memberships = fakeRepo<any>(opts.memberships ?? [], 'membership');
    // `createApiKey`'s org default reads the user with its memberships
    // joined; mirror that relation off the same table.
    users = fakeRepo<any>(
      [
        { id: OWNER, email: 'owner@example.com' },
        { id: OUTSIDER, email: 'outsider@example.com' },
      ],
      'user',
    );
    const plainUserFindOne = users.findOne.getMockImplementation()!;
    users.findOne.mockImplementation(async (options: any) => {
      const user = await plainUserFindOne(options);
      if (!user) return null;
      if (options?.relations?.organizationMemberships) {
        user.organizationMemberships = await memberships.find({
          where: { userId: user.id },
        });
      }
      return user;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(ApiKey), useValue: apiKeys },
        { provide: getRepositoryToken(Organization), useValue: fakeRepo<any>([], 'org') },
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

  // -------------------------------------------------------------------------
  // revokeApiKey
  // -------------------------------------------------------------------------

  describe('revokeApiKey', () => {
    const ownedKey = { id: 'key-1', userId: OWNER, organizationId: ORG, isActive: true };

    it('deactivates the stored row, not just the entity it loaded', async () => {
      await build({ apiKeys: [ownedKey] });

      await service.revokeApiKey('key-1', OWNER);

      expect(apiKeys.row('key-1').isActive).toBe(false);
    });

    /**
     * The `userId` half of the lookup. Without it, any authenticated user
     * who learns a key id -- they are uuids, but they appear in audit
     * entries and support threads -- can switch off somebody else's key.
     */
    it("refuses to revoke another user's key and leaves it active", async () => {
      await build({ apiKeys: [ownedKey] });

      await expect(service.revokeApiKey('key-1', OUTSIDER)).rejects.toThrow(
        BadRequestException,
      );

      expect(apiKeys.row('key-1').isActive).toBe(true);
      expect(apiKeys.save).not.toHaveBeenCalled();
    });

    it('reports a missing key the same way as a foreign one', async () => {
      await build({ apiKeys: [ownedKey] });

      await expect(service.revokeApiKey('key-nope', OWNER)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // createApiKey: the caller-supplied org
  // -------------------------------------------------------------------------

  describe('createApiKey with an explicit organization', () => {
    it('stamps an org the caller really belongs to', async () => {
      await build({ memberships: [realMembership()] });

      const { keyData } = await service.createApiKey(OWNER, {
        name: 'ci',
        organizationId: ORG,
      } as any);

      expect(keyData.organizationId).toBe(ORG);
    });

    it('refuses an org the caller has no row for', async () => {
      await build({ memberships: [realMembership()] });

      await expect(
        service.createApiKey(OWNER, { name: 'ci', organizationId: OTHER_ORG } as any),
      ).rejects.toThrow(ForbiddenException);

      expect(apiKeys.save).not.toHaveBeenCalled();
    });

    it('refuses an org whose membership was deactivated (a revoked invite)', async () => {
      await build({ memberships: [revokedInvite()] });

      await expect(
        service.createApiKey(OWNER, { name: 'ci', organizationId: ORG } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * A pending invite is a row that exists and is active, and is not a
     * membership: acceptance is what `POST /invites/:token/accept` records.
     * `isEffectiveMembership` is the one place that decides this, and
     * `createApiKey` used to decide it separately and more loosely -- so
     * being invited was enough to stamp the inviting org onto a key.
     */
    it('refuses an org whose invite has not been accepted yet', async () => {
      await build({ memberships: [pendingInvite()] });

      await expect(
        service.createApiKey(OWNER, { name: 'ci', organizationId: ORG } as any),
      ).rejects.toThrow(ForbiddenException);

      expect(apiKeys.save).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // createApiKey: the implicit single-org default
  // -------------------------------------------------------------------------

  describe('createApiKey with no organization asked for', () => {
    it('defaults to the caller single real org', async () => {
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

    it('does not default when the caller really belongs to two orgs', async () => {
      await build({
        memberships: [
          realMembership(),
          realMembership({ id: 'm-real-2', organizationId: OTHER_ORG }),
        ],
      });

      const { keyData } = await service.createApiKey(OWNER, { name: 'cli' } as any);

      expect(keyData.organizationId).toBeUndefined();
    });

    /**
     * One real membership next to a pending invite is still one org, and
     * it is the real one. Counting rows rather than memberships made this
     * two and defaulted to neither.
     */
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
