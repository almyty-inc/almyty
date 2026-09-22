import { ConnectionsResolverService } from '../connections-resolver.service';
import { ConnectionNotGrantedError } from '../grants/grants.service';
import { buildHarness, principal } from './test-support';

/**
 * Gate 2 wired into the resolver: use goes through GrantsService, which
 * also writes the single CONNECTION_RESOLVE row with the grant it used.
 */
describe('ConnectionsResolverService with grants', () => {
  const ORG = 'org-1';
  const openai = { method: 'GET', url: 'https://api.openai.com/v1/models', handle: () => ({ status: 200, body: { data: [{ id: 'gpt-4o' }] } }) };

  async function setup(grants: any) {
    const h = buildHarness({ routes: [openai], grants });
    const admin = principal('u-admin', ORG, 'admin');
    const org = await h.service.connect(admin, ORG, 'openai', { input: { apiKey: 'sk-org-wide-key' } });
    const resolver = new ConnectionsResolverService(h.service, h.catalog, h.audit, grants);
    return { h, resolver, orgId: (org as any).connection.id };
  }

  it('resolves through the grant decision and records exactly one resolve row via the grants service', async () => {
    const decision = { allowed: true, via: 'grant', grant: { id: 'g-1' } };
    const grants = { assertCanUse: jest.fn().mockResolvedValue(decision), recordResolve: jest.fn().mockResolvedValue(undefined), grantDefaultForOrgConnection: jest.fn().mockResolvedValue(null) };
    const { h, resolver, orgId } = await setup(grants);
    const member = principal('u-member', ORG, 'member');
    const resolved = await resolver.resolveForUse(member, orgId, { purpose: 'llm_call', resourceType: 'agent', resourceId: 'a-1' });
    expect(resolved.config.apiKey).toBe('sk-org-wide-key');
    expect(grants.assertCanUse).toHaveBeenCalledWith(member, expect.objectContaining({ id: orgId }), { purpose: 'llm_call', resourceType: 'agent', resourceId: 'a-1' });
    expect(grants.recordResolve).toHaveBeenCalledWith(member, expect.objectContaining({ id: orgId }), expect.objectContaining({ purpose: 'llm_call' }), decision);
    const resolveRows = h.audit.log.mock.calls.filter((c: any[]) => c[0].action === 'connection_resolve');
    expect(resolveRows).toHaveLength(0);
  });

  it('refuses with CONNECTION_NOT_GRANTED before decrypting anything', async () => {
    const grants = { assertCanUse: jest.fn().mockRejectedValue(new ConnectionNotGrantedError('c', 'no grant for member')), recordResolve: jest.fn(), grantDefaultForOrgConnection: jest.fn().mockResolvedValue(null) };
    const { resolver, orgId } = await setup(grants);
    await expect(resolver.resolveForUse(principal('u-member', ORG, 'member'), orgId)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_GRANTED' } });
    expect(grants.recordResolve).not.toHaveBeenCalled();
  });

  it('a new organization connection gets the member default grant, unless the org setting says none', async () => {
    const grants = { assertCanUse: jest.fn(), recordResolve: jest.fn(), grantDefaultForOrgConnection: jest.fn().mockResolvedValue({ id: 'g-default' }) };
    const { h, orgId } = await setup(grants);
    expect(grants.grantDefaultForOrgConnection).toHaveBeenCalledWith(expect.objectContaining({ id: orgId, ownerUserId: null }), 'u-admin');

    const strict = buildHarness({ routes: [openai], org: { settings: { connectionsDefaultGrant: 'none' } }, grants });
    grants.grantDefaultForOrgConnection.mockClear();
    await strict.service.connect(principal('u-admin', ORG, 'admin'), ORG, 'openai', { input: { apiKey: 'sk-org-wide-key' } });
    expect(grants.grantDefaultForOrgConnection).not.toHaveBeenCalled();
    void h;
  });

  it('asks the EE governance hook after the grant said yes, and its refusal wins', async () => {
    const decision = { allowed: true, via: 'grant' };
    const grants = { assertCanUse: jest.fn().mockResolvedValue(decision), recordResolve: jest.fn(), grantDefaultForOrgConnection: jest.fn().mockResolvedValue(null) };
    const governance = { beforeConnect: jest.fn().mockResolvedValue(undefined), beforeUse: jest.fn().mockResolvedValue(undefined) };
    const h = buildHarness({ routes: [openai], grants });
    const admin = principal('u-admin', ORG, 'admin');
    const org: any = await h.service.connect(admin, ORG, 'openai', { input: { apiKey: 'sk-org-wide-key' } });
    const resolver = new ConnectionsResolverService(h.service, h.catalog, h.audit, grants as any, governance as any);
    const member = principal('u-member', ORG, 'member');
    await resolver.resolveForUse(member, org.connection.id, { purpose: 'llm_call', resourceType: 'agent', resourceId: 'a-1' });
    expect(governance.beforeUse).toHaveBeenCalledWith(ORG, expect.objectContaining({ id: org.connection.id }), { userId: 'u-member', agentId: 'a-1', workspaceId: undefined }, expect.objectContaining({ purpose: 'llm_call' }), decision);

    governance.beforeUse.mockRejectedValueOnce(Object.assign(new Error('policy'), { response: { code: 'CONNECTION_POLICY_DENIED' } }));
    await expect(resolver.resolveForUse(member, org.connection.id)).rejects.toMatchObject({ response: { code: 'CONNECTION_POLICY_DENIED' } });
    expect(grants.recordResolve).toHaveBeenCalledTimes(1);
  });

  it('connect asks the governance hook before writing anything', async () => {
    const governance = { beforeConnect: jest.fn().mockRejectedValue(Object.assign(new Error('denied'), { response: { code: 'CONNECTION_POLICY_DENIED' } })), beforeUse: jest.fn() };
    const h = buildHarness({ routes: [openai] });
    (h.service as any).governance = governance;
    await expect(h.service.connect(principal('u-admin', ORG, 'admin'), ORG, 'openai', { input: { apiKey: 'sk-org-wide-key' } })).rejects.toMatchObject({ response: { code: 'CONNECTION_POLICY_DENIED' } });
    expect(governance.beforeConnect).toHaveBeenCalledWith(ORG, 'openai', 'org');
    expect(h.credentials.rows).toHaveLength(0);
  });
});
