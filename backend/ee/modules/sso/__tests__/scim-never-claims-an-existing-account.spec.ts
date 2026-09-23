import { ConflictException } from '@nestjs/common';

import { ScimService } from '../scim.service';

/**
 * SCIM is one organization's IdP writing into a platform-wide `users`
 * table keyed by email.
 *
 * `createUser` looked the email up globally and, when it found a row,
 * adopted it: a membership was written into the caller's org, `loadMember`
 * then passed, and `PUT`/`PATCH` wrote `users.firstName` / `lastName` —
 * the shared row every other tenant that person belongs to reads. Any
 * owner/admin who minted their own SCIM token could do this to anyone on
 * the platform.
 *
 * Two rules, matching the SSO one: SCIM creates identities, it does not
 * claim them; and it writes the shared profile only when this is the
 * person's only organization.
 */
describe('SCIM does not claim accounts it did not create', () => {
  const ORG = 'org-attacker';

  function makeService(overrides: {
    userByEmail?: any;
    membership?: any;
    otherMembershipCount?: number;
  } = {}) {
    const userRepo = {
      findOne: jest.fn(async ({ where }: any) =>
        where?.email ? overrides.userByEmail ?? null : overrides.userByEmail ?? null,
      ),
      create: jest.fn((partial: any) => ({ id: 'u-new', ...partial })),
      save: jest.fn(async (row: any) => row),
      find: jest.fn(async () => []),
    };
    const membershipRepo = {
      findOne: jest.fn(async () => overrides.membership ?? null),
      create: jest.fn((partial: any) => partial),
      save: jest.fn(async (row: any) => ({ id: 'm-1', ...row })),
      find: jest.fn(async () => []),
      count: jest.fn(async () => overrides.otherMembershipCount ?? 1),
    };
    const service = new ScimService(
      userRepo as any,
      membershipRepo as any,
      { findOne: jest.fn(async () => null) } as any,
      { findOne: jest.fn(async () => null), create: (p: any) => p, save: jest.fn(async (r: any) => r) } as any,
      { get: jest.fn(async () => null) } as any,
    );
    return { service, userRepo, membershipRepo };
  }

  const VICTIM = { id: 'u-victim', email: 'victim@othertenant.com', firstName: 'Real', lastName: 'Name' };

  it('refuses POST /Users for an address that already has an account', async () => {
    const { service, membershipRepo } = makeService({ userByEmail: VICTIM });

    await expect(
      service.createUser(ORG, { userName: VICTIM.email } as any),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(membershipRepo.save).not.toHaveBeenCalled();
  });

  it('still provisions a new identity', async () => {
    const { service, userRepo, membershipRepo } = makeService({ userByEmail: null });

    await service.createUser(ORG, { userName: 'newhire@attacker.example' } as any);

    expect(userRepo.save).toHaveBeenCalled();
    expect(membershipRepo.save).toHaveBeenCalled();
  });

  it('is idempotent for an address that is already a member here', async () => {
    const { service } = makeService({
      userByEmail: VICTIM,
      membership: { id: 'm-1', organizationId: ORG, isActive: true, role: 'member' },
    });

    await expect(
      service.createUser(ORG, { userName: VICTIM.email } as any),
    ).resolves.toBeDefined();
  });

  it('will not rename a person who belongs to another organization too', async () => {
    const { service, userRepo } = makeService({
      userByEmail: VICTIM,
      membership: { id: 'm-1', organizationId: ORG, isActive: true, role: 'member' },
      otherMembershipCount: 2,
    });

    await service.replaceUser(ORG, VICTIM.id, {
      userName: VICTIM.email,
      name: { givenName: 'Renamed', familyName: 'ByAttacker' },
    } as any);

    expect(userRepo.save).not.toHaveBeenCalled();
    expect(VICTIM.firstName).toBe('Real');
  });

  it('does rename someone this organization is the only home of', async () => {
    const own = { id: 'u-own', email: 'a@b.c', firstName: 'Old', lastName: 'Name' };
    const { service, userRepo } = makeService({
      userByEmail: own,
      membership: { id: 'm-1', organizationId: ORG, isActive: true, role: 'member' },
      otherMembershipCount: 1,
    });

    await service.replaceUser(ORG, own.id, {
      userName: own.email,
      name: { givenName: 'New', familyName: 'Name' },
    } as any);

    expect(userRepo.save).toHaveBeenCalled();
    expect(own.firstName).toBe('New');
  });
});
