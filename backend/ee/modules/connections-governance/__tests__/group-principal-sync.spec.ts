import { GroupPrincipalSyncService } from '../group-principal-sync.service';

const repo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  save: jest.fn(async (row: any) => row),
  create: jest.fn((row: any) => row),
});

function build(scim?: any) {
  const userTeams = repo();
  const teams = repo();
  const memberships = repo();
  return { service: new GroupPrincipalSyncService(userTeams as any, teams as any, memberships as any, scim), userTeams, teams, memberships };
}

describe('GroupPrincipalSyncService.principalsFor', () => {
  it('returns nothing for a non-member', async () => {
    const { service, userTeams } = build();
    expect(await service.principalsFor({ id: 'u1' }, 'org-1')).toEqual({ teamIds: [], roles: [] });
    expect(userTeams.find).not.toHaveBeenCalled();
  });

  it('returns the org role and only active teams of that org', async () => {
    const { service, userTeams, teams, memberships } = build();
    memberships.findOne.mockResolvedValue({ userId: 'u1', organizationId: 'org-1', role: 'member', isActive: true });
    userTeams.find.mockResolvedValue([{ teamId: 't1' }, { teamId: 't-other-org' }, { teamId: 't-inactive' }]);
    teams.find.mockResolvedValue([{ id: 't1' }]);
    expect(await service.principalsFor({ id: 'u1' }, 'org-1')).toEqual({ teamIds: ['t1'], roles: ['member'] });
    expect(userTeams.find).toHaveBeenCalledWith({ where: { userId: 'u1', isActive: true } });
    expect(teams.find).toHaveBeenCalledWith({ where: expect.objectContaining({ organizationId: 'org-1', isActive: true }) });
  });
});

describe('GroupPrincipalSyncService.syncGroups', () => {
  it('is a no-op without the SCIM service', async () => {
    expect(await build().service.syncGroups('org-1')).toEqual({ groups: 0, added: 0, removed: 0 });
  });

  it('activates listed members, deactivates the rest, and leaves matching rows alone', async () => {
    const scim = { listGroups: jest.fn().mockResolvedValue({ Resources: [{ id: 't1', members: [{ value: 'keep' }, { value: 'new' }, { value: 'back' }] }] }) };
    const { service, userTeams } = build(scim);
    userTeams.find.mockResolvedValue([
      { teamId: 't1', userId: 'keep', isActive: true },
      { teamId: 't1', userId: 'gone', isActive: true },
      { teamId: 't1', userId: 'back', isActive: false },
    ]);
    expect(await service.syncGroups('org-1')).toEqual({ groups: 1, added: 2, removed: 1 });
    expect(scim.listGroups).toHaveBeenCalledWith('org-1');
    expect(userTeams.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 'gone', isActive: false }));
    expect(userTeams.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 'back', isActive: true }));
    expect(userTeams.save).toHaveBeenCalledWith(expect.objectContaining({ teamId: 't1', userId: 'new', isActive: true }));
    expect(userTeams.save).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'keep' }));
  });
});
