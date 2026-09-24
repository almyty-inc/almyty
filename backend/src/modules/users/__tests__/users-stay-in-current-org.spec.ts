import { UsersService } from '../users.service';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { RecordingQueryBuilder } from '../../gateways/__tests__/recording-query-builder';

/**
 * An admin reads their own organization's people through GET /users and
 * GET /users/:id. A person's user row is platform-wide, and the
 * memberships hanging off it name every other organization they belong
 * to and their role there. Those are not this organization's to read.
 */
describe('/users stays inside the current organization', () => {
  const ORG_A = 'org-a';
  const ORG_B = 'org-b';

  const organizations: Record<string, any> = {
    [ORG_A]: { id: ORG_A, name: 'Acme' },
    [ORG_B]: { id: ORG_B, name: 'Other Corp' },
  };
  const memberships = [
    { id: 'm1', userId: 'admin', organizationId: ORG_A, role: OrganizationRole.ADMIN, isActive: true, inviteAccepted: true, inviteToken: null },
    { id: 'm2', userId: 'alice', organizationId: ORG_A, role: OrganizationRole.MEMBER, isActive: true, inviteAccepted: true, inviteToken: null },
    { id: 'm3', userId: 'alice', organizationId: ORG_B, role: OrganizationRole.OWNER, isActive: true, inviteAccepted: true, inviteToken: null },
  ];
  const people = [
    { id: 'admin', email: 'admin@acme.test', createdAt: new Date('2026-01-01') },
    { id: 'alice', email: 'alice@acme.test', createdAt: new Date('2026-01-02') },
  ];

  /**
   * TypeORM's reading of the joins the service asked for: an inner join on
   * the membership relation limits the users, and every *AndSelect join on
   * it loads the memberships its ON condition admits -- all of them when
   * it has none. A condition this double does not recognise throws.
   */
  function evaluate(qb: RecordingQueryBuilder): [any[], number] {
    const joins = qb.calls.filter(
      (c) => /join/i.test(c.method) && c.args[0] === 'user.organizationMemberships',
    );
    const admits = (condition: string | undefined, params: Record<string, any>) => {
      if (!condition) return () => true;
      const m = /^(\w+)\.organizationId = :(\w+)$/.exec(condition.trim());
      if (!m) throw new Error(`unmodelled join condition: ${condition}`);
      return (row: any) => row.organizationId === params[m[2]];
    };
    let users = people.map((p) => ({ ...p }));
    const selected: any[] = [];
    for (const join of joins) {
      const filter = admits(join.args[2], join.args[3] ?? {});
      if (join.method.startsWith('inner')) {
        users = users.filter((u) => memberships.some((m) => m.userId === u.id && filter(m)));
      }
      if (join.method.endsWith('AndSelect')) selected.push(...memberships.filter(filter));
    }
    const loadsOrganization = qb.calls.some((c) => c.method === 'leftJoinAndSelect' && /\.organization$/.test(c.args[0]));
    const out = users.map((u) => ({
      ...u,
      passwordHash: 'hash',
      organizationMemberships: [...new Map(selected.filter((m) => m.userId === u.id).map((m) => [m.id, m])).values()].map(
        (m) => ({ ...m, ...(loadsOrganization ? { organization: organizations[m.organizationId] } : {}) }),
      ),
    }));
    return [out, out.length];
  }

  function build() {
    let qb: RecordingQueryBuilder;
    const userRepo: any = fakeRepository(
      people.map((p) => ({
        ...p,
        organizationMemberships: memberships.filter((m) => m.userId === p.id).map((m) => ({ ...m, organization: organizations[m.organizationId] })),
        apiKeys: [],
      })),
    );
    userRepo.createQueryBuilder = () => {
      qb = new RecordingQueryBuilder('user', { getManyAndCount: () => evaluate(qb) });
      return qb;
    };
    const service = new UsersService(userRepo, fakeRepository(memberships) as any, fakeRepository() as any);
    return service;
  }

  it('GET /users lists the people in this organization with this membership only', async () => {
    const result = await build().findAll({ organizationId: ORG_A });

    expect(result.users.map((u) => u.id).sort()).toEqual(['admin', 'alice']);
    for (const user of result.users) {
      expect(user.organizationMemberships.map((m: any) => m.organizationId)).toEqual([ORG_A]);
    }
    expect(JSON.stringify(result)).not.toContain('Other Corp');
    expect(JSON.stringify(result)).not.toContain('hash');
  });

  it('GET /users/:id shows the person only as a member of this organization', async () => {
    const service = build();
    const alice = await service.findOneInOrg('alice', ORG_A);
    expect(alice.organizationMemberships.map((m: any) => m.organizationId)).toEqual([ORG_A]);
    expect(JSON.stringify(alice)).not.toContain('Other Corp');

    const stats = await service.getUserStatsInOrg('alice', ORG_A);
    expect(stats.organizationsCount).toBe(1);
  });
});
