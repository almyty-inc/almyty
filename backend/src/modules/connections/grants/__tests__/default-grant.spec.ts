import { GrantsService } from '../grants.service';

describe('GrantsService.grantDefaultForOrgConnection', () => {
  function build(existing: any[] = []) {
    const rows = [...existing];
    const grants = {
      find: jest.fn(async () => rows),
      create: jest.fn((p: any) => ({ ...p })),
      save: jest.fn(async (r: any) => { r.id = r.id ?? 'g-1'; rows.push(r); return r; }),
    };
    const audit = { log: jest.fn().mockResolvedValue(null) };
    const svc = new GrantsService(grants as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, audit as any);
    return { svc, grants, audit, rows };
  }

  it('writes a role:member use grant for an org connection and audits it as a default', async () => {
    const { svc, audit, rows } = build();
    const view = await svc.grantDefaultForOrgConnection({ id: 'c-1', organizationId: 'org', name: 'OpenAI', ownerUserId: null }, 'u-admin');
    expect(view).toMatchObject({ principalType: 'role', principalId: 'member', permission: 'use' });
    expect(rows[0]).toMatchObject({ connectionId: 'c-1', grantedBy: 'u-admin' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_grant', details: expect.objectContaining({ default: true, principalId: 'member' }) }));
  });

  it('never applies to a user connection and does not duplicate an existing member grant', async () => {
    const { svc, grants } = build([{ id: 'g-0', principalType: 'role', principalId: 'member' }]);
    expect(await svc.grantDefaultForOrgConnection({ id: 'c-1', organizationId: 'org', ownerUserId: 'u-1' }, 'u-1')).toBeNull();
    expect(await svc.grantDefaultForOrgConnection({ id: 'c-1', organizationId: 'org', ownerUserId: null }, 'u-admin')).toBeNull();
    expect(grants.save).not.toHaveBeenCalled();
  });
});
