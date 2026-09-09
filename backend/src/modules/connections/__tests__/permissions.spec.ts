import { UserOrganization, OrganizationRole } from '../../../entities/user-organization.entity';
import { CONNECTIONS_MANAGE, CONNECTIONS_READ, principalHasPermission, roleHasConnectionPermission } from '../connections.permissions';
import { defaultAllowUserScopedConnections } from '../connections.service';
import { buildHarness, principal } from './test-support';

const ok = { url: 'https://api.openai.com/v1/models', handle: () => ({ status: 200, body: { data: [] } }) };

describe('connections permissions', () => {
  const ORG = 'org-1';

  it('role defaults: owner/admin manage, member/viewer read; membership permissions add; the entity agrees', () => {
    expect(roleHasConnectionPermission('owner', CONNECTIONS_MANAGE)).toBe(true);
    expect(roleHasConnectionPermission('admin', CONNECTIONS_MANAGE)).toBe(true);
    expect(roleHasConnectionPermission('member', CONNECTIONS_MANAGE)).toBe(false);
    expect(roleHasConnectionPermission('member', CONNECTIONS_READ)).toBe(true);
    expect(roleHasConnectionPermission('viewer', CONNECTIONS_READ)).toBe(true);
    expect(roleHasConnectionPermission(undefined, CONNECTIONS_READ)).toBe(false);
    expect(principalHasPermission(principal('u', ORG, 'member', [CONNECTIONS_MANAGE]), ORG, CONNECTIONS_MANAGE)).toBe(true);
    expect(principalHasPermission(principal('u', 'other-org', 'owner'), ORG, CONNECTIONS_READ)).toBe(false);

    for (const role of [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.MEMBER, OrganizationRole.VIEWER]) {
      const m = Object.assign(new UserOrganization(), { role, permissions: null });
      expect(m.hasPermission(CONNECTIONS_READ)).toBe(roleHasConnectionPermission(role, CONNECTIONS_READ));
      expect(m.hasPermission(CONNECTIONS_MANAGE)).toBe(roleHasConnectionPermission(role, CONNECTIONS_MANAGE));
    }
  });

  it('a member without connections:manage cannot create an org connection; an admin can', async () => {
    const h = buildHarness({ routes: [ok] });
    await expect(h.service.connect(principal('u-m', ORG, 'member'), ORG, 'openai', { owner: 'org', input: { apiKey: 'sk-member-key' } })).rejects.toMatchObject({ response: { code: 'CONNECTIONS_PERMISSION_REQUIRED' } });
    await expect(h.service.connect(principal('u-x', 'other', 'owner'), ORG, 'openai', { owner: 'org', input: { apiKey: 'sk-member-key' } })).rejects.toMatchObject({ response: { code: 'NOT_A_MEMBER' } });
    expect(h.credentials.rows).toHaveLength(0);
    const done = await h.service.connect(principal('u-a', ORG, 'admin'), ORG, 'openai', { owner: 'org', input: { apiKey: 'sk-admin-key' } });
    expect(done.pending).toBe(false);
    const granted = await h.service.connect(principal('u-g', ORG, 'member', [CONNECTIONS_MANAGE]), ORG, 'openai', { owner: 'org', input: { apiKey: 'sk-granted-key' } });
    expect(granted.pending).toBe(false);
  });

  it('user-scoped connections follow the org setting: on by default for free orgs, off for paid, admin-flippable', async () => {
    expect(defaultAllowUserScopedConnections('free')).toBe(true);
    expect(defaultAllowUserScopedConnections(undefined)).toBe(true);
    expect(defaultAllowUserScopedConnections('pro')).toBe(false);
    expect(defaultAllowUserScopedConnections('enterprise')).toBe(false);

    const free = buildHarness({ routes: [ok] });
    const mine = await free.service.connect(principal('u-m', ORG, 'member'), ORG, 'openai', { owner: 'user', input: { apiKey: 'sk-my-own-key' } });
    if (mine.pending !== false) throw new Error('expected a connection');
    expect(mine.connection).toMatchObject({ owner: 'user', ownerUserId: 'u-m' });

    const pro = buildHarness({ routes: [ok], org: { plan: 'pro' } });
    await expect(pro.service.connect(principal('u-m', ORG, 'member'), ORG, 'openai', { owner: 'user', input: { apiKey: 'sk-my-own-key' } })).rejects.toMatchObject({ response: { code: 'USER_CONNECTIONS_DISABLED' } });
    expect(pro.credentials.rows).toHaveLength(0);

    const flipped = buildHarness({ routes: [ok], org: { plan: 'pro', settings: { allowUserScopedConnections: true } } });
    const allowed = await flipped.service.connect(principal('u-m', ORG, 'member'), ORG, 'openai', { owner: 'user', input: { apiKey: 'sk-my-own-key' } });
    expect(allowed.pending).toBe(false);

    const closedFree = buildHarness({ routes: [ok], org: { plan: 'free', settings: { allowUserScopedConnections: false } } });
    await expect(closedFree.service.connect(principal('u-m', ORG, 'member'), ORG, 'openai', { owner: 'user', input: { apiKey: 'sk-my-own-key' } })).rejects.toMatchObject({ response: { code: 'USER_CONNECTIONS_DISABLED' } });
  });

  it('user connections are visible and manageable by their owner and by connections:manage holders only', async () => {
    const h = buildHarness({ routes: [ok] });
    const owner = principal('u-owner', ORG, 'member');
    const other = principal('u-other', ORG, 'member');
    const admin = principal('u-admin', ORG, 'admin');
    const mine = await h.service.connect(owner, ORG, 'openai', { owner: 'user', input: { apiKey: 'sk-my-own-key' } });
    if (mine.pending !== false) throw new Error('expected a connection');
    const shared = await h.service.connect(admin, ORG, 'openai', { owner: 'org', input: { apiKey: 'sk-org-wide-key' } });
    if (shared.pending !== false) throw new Error('expected a connection');

    expect((await h.service.list(owner, ORG)).map((c) => c.id).sort()).toEqual([mine.connection.id, shared.connection.id].sort());
    expect((await h.service.list(other, ORG)).map((c) => c.id)).toEqual([shared.connection.id]);
    expect((await h.service.list(admin, ORG)).length).toBe(2);
    await expect(h.service.get(other, ORG, mine.connection.id)).rejects.toMatchObject({ response: { code: 'CONNECTION_FORBIDDEN' } });
    await expect(h.service.validate(other, ORG, mine.connection.id)).rejects.toMatchObject({ response: { code: 'CONNECTION_FORBIDDEN' } });
    await expect(h.service.disconnect(other, ORG, shared.connection.id)).rejects.toMatchObject({ response: { code: 'CONNECTIONS_PERMISSION_REQUIRED' } });
    await expect(h.service.rotate(other, ORG, mine.connection.id, {})).rejects.toMatchObject({ response: { code: 'CONNECTION_FORBIDDEN' } });
    expect((await h.service.validate(owner, ORG, mine.connection.id)).health.status).toBe('valid');
    expect((await h.service.disconnect(admin, ORG, mine.connection.id)).revoked).toBe(false);
    expect(h.credentials.rows).toHaveLength(1);
  });

  it('the list ignores plain credentials that are not connections', async () => {
    const h = buildHarness({ routes: [ok] });
    h.credentials.rows.push(Object.assign(h.credentials.create({ organizationId: ORG, name: 'legacy', type: 'api_key' as any, config: { apiKey: 'x' } }), { id: 'legacy-1' }));
    expect(await h.service.list(principal('u', ORG, 'member'), ORG)).toEqual([]);
  });
});
