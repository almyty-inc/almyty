import { ScimService } from '../scim.service';

/**
 * A SCIM group maps to one organization's team, and the members it may
 * hold are that organization's people. The member list is a set of user
 * ids straight from the request, and they went into `user_teams` as
 * given -- so an organization's SCIM token could put any user id on the
 * platform, from any tenant, on its own teams (and read them back from
 * the group listing).
 */
describe('SCIM groups hold only members of the organization', () => {
  const ORG = 'org-a';
  const TEAM = { id: 'team-1', organizationId: ORG, name: 'Eng' };
  const memberships = [
    { userId: 'u-member', organizationId: ORG, isActive: true, inviteAccepted: true, inviteToken: null },
    { userId: 'u-invited', organizationId: ORG, isActive: true, inviteAccepted: false, inviteToken: 't' },
    { userId: 'u-outsider', organizationId: 'org-b', isActive: true, inviteAccepted: true, inviteToken: null },
  ];

  function makeService() {
    const added: any[] = [];
    const match = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
    const service = new ScimService(
      {} as any,
      {
        findOne: jest.fn(async ({ where }: any) => memberships.find((m) => match(m, where)) ?? null),
        find: jest.fn(async ({ where }: any) => memberships.filter((m) => match(m, where))),
      } as any,
      {
        findOne: jest.fn(async ({ where }: any) => (where.id === TEAM.id || where.name ? (where.name ? null : TEAM) : null)),
        create: jest.fn((row: any) => ({ id: TEAM.id, ...row })),
        save: jest.fn(async (row: any) => row),
      } as any,
      {
        findOne: jest.fn(async () => null),
        find: jest.fn(async () => added),
        create: jest.fn((row: any) => row),
        save: jest.fn(async (row: any) => {
          added.push(row);
          return row;
        }),
      } as any,
      {} as any,
    );
    return { service, added };
  }

  it('PATCH add ignores users who are not members of the organization', async () => {
    const { service, added } = makeService();
    await service.patchGroup(ORG, TEAM.id, {
      Operations: [
        { op: 'add', path: 'members', value: [{ value: 'u-member' }, { value: 'u-outsider' }, { value: 'u-invited' }] },
      ],
    });
    expect(added.map((r) => r.userId)).toEqual(['u-member']);
  });

  it('POST ignores them too', async () => {
    const { service, added } = makeService();
    await service.createGroup(ORG, {
      displayName: 'New',
      members: [{ value: 'u-outsider' }, { value: 'u-member' }],
    });
    expect(added.map((r) => r.userId)).toEqual(['u-member']);
  });
});
