import { UsersService } from '../users.service';
import { OrganizationRole } from '../../../entities/user-organization.entity';

/**
 * `/users/:id` admin routes are org-scoped: an admin of org A acts on the
 * people in org A. The `users` row they reach is platform-wide, though --
 * the same row signs the person into every other organization they
 * belong to. These pin that an org admin cannot use it to reach past
 * their own organization:
 *
 *  - a pending invite is not a membership (an admin can invite any
 *    address and so create one at will);
 *  - the login address is the person's, not the org's: repointing it and
 *    then running "forgot password" against the new mailbox is a full
 *    takeover of every organization the person is in;
 *  - deactivating or deleting "in this org" must not lock the person out
 *    of, or erase them from, every other org.
 */
describe('org admin /users routes stay inside the organization', () => {
  const ORG_A = 'org-a';
  const ORG_B = 'org-b';
  const ADMIN = 'admin-a';
  const VICTIM = 'victim';

  let users: Map<string, any>;
  let memberships: any[];
  let apiKeyUpdates: any[];
  let removed: string[];
  // Untyped so the same spec runs (and fails) against the old signatures.
  let service: any;

  const match = (row: any, where: any) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  beforeEach(() => {
    users = new Map([
      [ADMIN, { id: ADMIN, email: 'admin@a.test', firstName: 'Ad', lastName: 'Min', isActive: true }],
      [VICTIM, { id: VICTIM, email: 'victim@b.test', firstName: 'Vic', lastName: 'Tim', isActive: true, isVerified: true }],
    ]);
    memberships = [
      { id: 'm1', userId: ADMIN, organizationId: ORG_A, role: OrganizationRole.ADMIN, isActive: true, inviteAccepted: true, inviteToken: null, organization: { id: ORG_A, name: 'A' } },
      { id: 'm2', userId: VICTIM, organizationId: ORG_B, role: OrganizationRole.MEMBER, isActive: true, inviteAccepted: true, inviteToken: null, organization: { id: ORG_B, name: 'B' } },
    ];
    apiKeyUpdates = [];
    removed = [];

    const userRepo: any = {
      findOne: jest.fn(async ({ where }: any) => {
        const u = users.get(where.id);
        if (!u) return null;
        return { ...u, organizationMemberships: memberships.filter((m) => m.userId === u.id), apiKeys: [] };
      }),
      save: jest.fn(async (u: any) => {
        const { organizationMemberships: _m, apiKeys: _k, ...row } = u;
        users.set(u.id, { ...users.get(u.id), ...row });
        return u;
      }),
      remove: jest.fn(async (u: any) => {
        removed.push(u.id);
        users.delete(u.id);
      }),
      createQueryBuilder: jest.fn(),
    };
    const membershipRepo: any = {
      findOne: jest.fn(async ({ where }: any) => memberships.find((m) => match(m, where)) ?? null),
      find: jest.fn(async ({ where }: any) => memberships.filter((m) => match(m, where))),
      count: jest.fn(async ({ where }: any) => memberships.filter((m) => match(m, where)).length),
      save: jest.fn(async (m: any) => {
        const i = memberships.findIndex((x) => x.id === m.id);
        memberships[i] = { ...memberships[i], ...m };
        return m;
      }),
    };
    const apiKeyRepo: any = {
      update: jest.fn(async (where: any, set: any) => apiKeyUpdates.push({ where, set })),
      count: jest.fn(async () => 0),
      find: jest.fn(async () => []),
    };
    service = new UsersService(userRepo, membershipRepo, apiKeyRepo);
    // No other account holds the new address.
    jest.spyOn(service, 'findByEmail').mockResolvedValue(null as any);
  });

  const inviteVictimToA = () =>
    memberships.push({
      id: 'm3', userId: VICTIM, organizationId: ORG_A, role: OrganizationRole.MEMBER,
      isActive: true, inviteAccepted: false, inviteToken: 'tok', organization: { id: ORG_A, name: 'A' },
    });
  const victimJoinsA = () =>
    memberships.push({
      id: 'm3', userId: VICTIM, organizationId: ORG_A, role: OrganizationRole.MEMBER,
      isActive: true, inviteAccepted: true, inviteToken: null, organization: { id: ORG_A, name: 'A' },
    });

  it('a pending invite does not let the inviting admin edit the invitee', async () => {
    inviteVictimToA();
    await expect(
      service.updateInOrg(VICTIM, ORG_A, { email: 'attacker@evil.test' }, ADMIN),
    ).rejects.toThrow();
    expect(users.get(VICTIM).email).toBe('victim@b.test');
  });

  it("an org admin cannot repoint a member's login address", async () => {
    victimJoinsA();
    await expect(
      service.updateInOrg(VICTIM, ORG_A, { email: 'attacker@evil.test' }, ADMIN),
    ).rejects.toThrow();
    expect(users.get(VICTIM).email).toBe('victim@b.test');
  });

  it('a person can still change their own address through the same route', async () => {
    await service.updateInOrg(ADMIN, ORG_A, { email: 'new-admin@a.test' }, ADMIN);
    expect(users.get(ADMIN).email).toBe('new-admin@a.test');
  });

  it('does not rename someone who also belongs to another organization', async () => {
    victimJoinsA();
    await service.updateInOrg(VICTIM, ORG_A, { firstName: 'Renamed' }, ADMIN);
    expect(users.get(VICTIM).firstName).toBe('Vic');
  });

  it('deactivating in org A leaves the account and org B alone', async () => {
    victimJoinsA();
    await service.deactivateInOrg(VICTIM, ORG_A, ADMIN);
    expect(users.get(VICTIM).isActive).toBe(true);
    expect(memberships.find((m) => m.userId === VICTIM && m.organizationId === ORG_B).isActive).toBe(true);
    expect(memberships.find((m) => m.userId === VICTIM && m.organizationId === ORG_A).isActive).toBe(false);
    // Only the keys minted in org A go.
    expect(apiKeyUpdates.length).toBeGreaterThan(0);
    for (const u of apiKeyUpdates) {
      expect(u.where).toEqual({ userId: VICTIM, organizationId: ORG_A });
    }
  });

  it('a pending invite does not let the inviting admin deactivate the invitee', async () => {
    inviteVictimToA();
    await expect(service.deactivateInOrg(VICTIM, ORG_A, ADMIN)).rejects.toThrow();
    expect(users.get(VICTIM).isActive).toBe(true);
    expect(apiKeyUpdates).toHaveLength(0);
  });

  it('an admin cannot deactivate an owner of their organization', async () => {
    memberships.push({
      id: 'm4', userId: VICTIM, organizationId: ORG_A, role: OrganizationRole.OWNER,
      isActive: true, inviteAccepted: true, inviteToken: null, organization: { id: ORG_A, name: 'A' },
    });
    await expect(service.deactivateInOrg(VICTIM, ORG_A, ADMIN)).rejects.toThrow();
    expect(memberships.find((m) => m.id === 'm4').isActive).toBe(true);
  });

  it('reactivating in org A restores the org A membership', async () => {
    victimJoinsA();
    await service.deactivateInOrg(VICTIM, ORG_A, ADMIN);
    await service.reactivateInOrg(VICTIM, ORG_A);
    expect(memberships.find((m) => m.id === 'm3').isActive).toBe(true);
  });

  it('reactivating cannot turn a revoked invite into a membership', async () => {
    memberships.push({
      id: 'm5', userId: VICTIM, organizationId: ORG_A, role: OrganizationRole.MEMBER,
      isActive: false, inviteAccepted: false, inviteToken: 'tok', organization: { id: ORG_A, name: 'A' },
    });
    await expect(service.reactivateInOrg(VICTIM, ORG_A)).rejects.toThrow();
    expect(memberships.find((m) => m.id === 'm5').isActive).toBe(false);
  });

  it('deleting "in org A" does not delete an account that belongs to org B', async () => {
    victimJoinsA();
    await expect(service.deleteInOrg(VICTIM, ORG_A)).rejects.toThrow();
    expect(removed).toEqual([]);
  });

  it('a pending invite does not let the inviting owner delete the invitee', async () => {
    inviteVictimToA();
    await expect(service.deleteInOrg(VICTIM, ORG_A)).rejects.toThrow();
    expect(removed).toEqual([]);
  });

  it('still deletes an account whose only organization is this one', async () => {
    memberships = memberships.filter((m) => m.userId !== VICTIM);
    victimJoinsA();
    await service.deleteInOrg(VICTIM, ORG_A);
    expect(removed).toEqual([VICTIM]);
  });
});
