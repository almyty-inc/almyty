import { UnauthorizedException } from '@nestjs/common';

import { SsoService } from '../sso.service';
import { SamlReplayCache } from '../saml-replay-cache';
import { FakeRedis } from '../../../../src/test/fake-redis';
import { OrganizationRole } from '../../../../src/entities/user-organization.entity';

/**
 * An organization's IdP may create identities. It may not claim one that
 * already exists.
 *
 * `users` is platform-wide and keyed by email, and each org configures its
 * own SAML certificate or OIDC client. `resolveUser` looked an asserted
 * email up globally and, when JIT was on, provisioned a membership and
 * returned that row — which `SsoController.issueSession` turns into the
 * ordinary `access_token` cookie, carrying every organization the victim
 * belongs to. So any owner of any org could self-sign an assertion for
 * someone else's address and get a full dashboard session as that person.
 *
 * There is no verified-domain concept here, so nothing binds an asserted
 * email to the asserting organization. The only safe rule is: JIT creates,
 * never adopts. Adding an existing account is what invites and SCIM are
 * for, and the account holder sees both.
 */
describe('SSO JIT provisioning never adopts an existing account', () => {
  const ATTACKER_ORG = 'org-attacker';
  const VICTIM = {
    id: 'u-victim',
    email: 'victim@othertenant.com',
    organizationMemberships: [],
  };

  const JIT_ON = {
    enabled: true,
    protocol: 'saml' as const,
    jitProvisioning: true,
    defaultRole: OrganizationRole.MEMBER,
  } as any;

  function makeService(overrides: {
    userByEmail?: any;
    membership?: any;
  } = {}) {
    const userRepo = {
      findOne: jest.fn(async () => overrides.userByEmail ?? null),
      create: jest.fn((partial: any) => ({ id: 'u-new', ...partial })),
      save: jest.fn(async (row: any) => row),
    };
    const membershipRepo = {
      findOne: jest.fn(async () => overrides.membership ?? null),
      create: jest.fn((partial: any) => partial),
      save: jest.fn(async (row: any) => row),
    };
    const service = new SsoService(
      userRepo as any,
      membershipRepo as any,
      { getDecrypted: jest.fn() } as any,
      new SamlReplayCache(new FakeRedis()),
    );
    return { service, userRepo, membershipRepo };
  }

  it('refuses an assertion naming an account that is not a member, even with JIT on', async () => {
    const { service, membershipRepo } = makeService({ userByEmail: VICTIM });

    await expect(
      service.resolveUser(ATTACKER_ORG, { email: VICTIM.email }, JIT_ON),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // And, crucially, no membership was written on the way out.
    expect(membershipRepo.save).not.toHaveBeenCalled();
  });

  it('is not case-sensitive about it', async () => {
    const { service } = makeService({ userByEmail: VICTIM });
    await expect(
      service.resolveUser(ATTACKER_ORG, { email: 'VICTIM@OtherTenant.com' }, JIT_ON),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still provisions a genuinely new identity', async () => {
    const { service, userRepo, membershipRepo } = makeService({ userByEmail: null });

    const user = await service.resolveUser(
      ATTACKER_ORG,
      { email: 'newhire@attacker.example' },
      JIT_ON,
    );

    expect(user.id).toBe('u-new');
    expect(userRepo.save).toHaveBeenCalled();
    expect(membershipRepo.save).toHaveBeenCalled();
  });

  it('lets a real member in', async () => {
    const { service } = makeService({
      userByEmail: VICTIM,
      membership: { isActive: true, inviteAccepted: true, inviteToken: null },
    });

    await expect(
      service.resolveUser(ATTACKER_ORG, { email: VICTIM.email }, JIT_ON),
    ).resolves.toBe(VICTIM);
  });

  it('refuses a member whose access was deactivated', async () => {
    const { service } = makeService({
      userByEmail: VICTIM,
      membership: { isActive: false, inviteAccepted: true, inviteToken: null },
    });

    await expect(
      service.resolveUser(ATTACKER_ORG, { email: VICTIM.email }, JIT_ON),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses to accept an invite on the user\'s behalf', async () => {
    // A pending invite is a row, but not yet a membership. The IdP does
    // not get to click accept for them.
    const { service } = makeService({
      userByEmail: VICTIM,
      membership: { isActive: true, inviteAccepted: false, inviteToken: 'tok' },
    });

    await expect(
      service.resolveUser(ATTACKER_ORG, { email: VICTIM.email }, JIT_ON),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
