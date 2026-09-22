import { ConnectionsResolverService } from '../connections-resolver.service';
import { buildHarness, principal } from './test-support';

const ok = { url: 'https://api.openai.com/v1/models', handle: () => ({ status: 200, body: { data: [] } }) };

describe('ConnectionsResolverService.resolveForUse (the gate 2 / gate 3 seam)', () => {
  const ORG = 'org-1';

  async function setup() {
    const h = buildHarness({ routes: [ok] });
    const resolver = new ConnectionsResolverService(h.service, h.catalog, h.audit);
    const admin = principal('u-admin', ORG, 'admin');
    const owner = principal('u-owner', ORG, 'member');
    const org = await h.service.connect(admin, ORG, 'openai', { owner: 'org', input: { apiKey: 'sk-org-wide-key' } });
    const user = await h.service.connect(owner, ORG, 'openai', { owner: 'user', input: { apiKey: 'sk-my-own-key' } });
    if (org.pending !== false || user.pending !== false) throw new Error('expected connections');
    return { h, resolver, admin, owner, orgId: org.connection.id, userId: user.connection.id };
  }

  it('hands a member the decrypted config of an org connection and audits CONNECTION_RESOLVE', async () => {
    const { h, resolver, orgId } = await setup();
    const member = principal('u-member', ORG, 'member');
    const resolved = await resolver.resolveForUse(member, orgId, { purpose: 'llm_call', resourceType: 'agent', resourceId: 'a-1' });
    expect(resolved.config.apiKey).toBe('sk-org-wide-key');
    expect(resolved.connector.key).toBe('openai');
    expect(resolved.connection).toMatchObject({ id: orgId, owner: 'org', health: { status: 'valid' } });
    expect(JSON.stringify(resolved.connection)).not.toContain('sk-org');
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'connection_resolve', resourceType: 'connection', resourceId: orgId, userId: 'u-member',
      details: expect.objectContaining({ purpose: 'llm_call', resourceType: 'agent', resourceId: 'a-1', owner: 'org' }),
    }));
  });

  it('a user connection resolves only for its owner; other members and even admins are refused until gate 2 grants', async () => {
    const { resolver, owner, admin, userId } = await setup();
    expect((await resolver.resolveForUse(owner, userId)).config.apiKey).toBe('sk-my-own-key');
    await expect(resolver.resolveForUse(principal('u-member', ORG, 'member'), userId)).rejects.toMatchObject({ response: { code: 'CONNECTION_FORBIDDEN' } });
    await expect(resolver.resolveForUse(admin, userId)).rejects.toMatchObject({ response: { code: 'CONNECTION_FORBIDDEN' } });
  });

  it('non-members, unknown ids, plain credentials and inactive rows do not resolve', async () => {
    const { h, resolver, orgId } = await setup();
    await expect(resolver.resolveForUse(principal('u-x', 'other-org', 'owner'), orgId)).rejects.toMatchObject({ response: { code: 'CONNECTION_FORBIDDEN' } });
    await expect(resolver.resolveForUse(principal('u-x', ORG, 'member'), 'missing')).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    h.credentials.rows.push(Object.assign(h.credentials.create({ organizationId: ORG, name: 'legacy', type: 'api_key' as any, config: { apiKey: 'x' } }), { id: 'legacy-1' }));
    await expect(resolver.resolveForUse(principal('u-x', ORG, 'member'), 'legacy-1')).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    h.credentials.rows.find((r) => r.id === orgId)!.isActive = false;
    await expect(resolver.resolveForUse(principal('u-x', ORG, 'member'), orgId)).rejects.toMatchObject({ response: { code: 'CONNECTION_INACTIVE' } });
  });

  it('resolveForOrg serves system jobs org-owned connections only', async () => {
    const { resolver, orgId, userId } = await setup();
    expect((await resolver.resolveForOrg(ORG, orgId, { purpose: 'scheduler' })).config.apiKey).toBe('sk-org-wide-key');
    await expect(resolver.resolveForOrg('other-org', orgId, { purpose: 'scheduler' })).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    await expect(resolver.resolveForOrg(ORG, userId, { purpose: 'scheduler' })).rejects.toMatchObject({ response: { code: 'CONNECTION_FORBIDDEN' } });
    expect((await resolver.resolveForOrg(ORG, userId, { purpose: 'scheduler', actorUserId: 'u-owner' })).config.apiKey).toBe('sk-my-own-key');
  });
});
