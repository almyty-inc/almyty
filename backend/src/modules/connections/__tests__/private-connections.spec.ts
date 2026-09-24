import { Credential, CredentialType } from '../../../entities/credential.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { buildHarness, principal } from './test-support';

/**
 * A private ("just me") connection is its owner's alone. The personal
 * tier (ownerUserId, visibility 'org') is visible to its owner and to
 * admins; private is not: another member and an org admin/owner get the
 * same not-found an id that does not exist gets.
 */
describe('private connections', () => {
  const ORG = 'org-1';
  const owner = principal('owner-1', ORG, OrganizationRole.MEMBER);
  const peer = principal('peer-1', ORG, OrganizationRole.MEMBER);
  const admin = principal('admin-1', ORG, OrganizationRole.ADMIN);
  const orgOwner = principal('boss-1', ORG, OrganizationRole.OWNER);

  function seed() {
    const h = buildHarness();
    const row = Object.assign(new Credential(), {
      id: 'conn-private', organizationId: ORG, name: 'my key', type: CredentialType.API_KEY,
      connectorKey: 'openai', config: { apiKey: 'sk' }, visibility: 'private', teamId: null,
      ownerUserId: 'owner-1', isActive: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const personal = Object.assign(new Credential(), {
      id: 'conn-personal', organizationId: ORG, name: 'personal', type: CredentialType.API_KEY,
      connectorKey: 'openai', config: { apiKey: 'sk' }, visibility: 'org', teamId: null,
      ownerUserId: 'peer-1', isActive: true, createdAt: new Date(), updatedAt: new Date(),
    });
    h.credentials.rows.push(row, personal);
    return h;
  }

  it('lists it to its owner only; admins still see personal (non-private) connections', async () => {
    const h = seed();
    expect((await h.service.list(owner, ORG)).map((c) => c.id)).toContain('conn-private');
    for (const who of [peer, admin, orgOwner]) {
      expect((await h.service.list(who, ORG)).map((c) => c.id)).not.toContain('conn-private');
    }
    expect((await h.service.list(admin, ORG)).map((c) => c.id)).toContain('conn-personal');
  });

  it('get, validate and disconnect are not found for everyone but the owner', async () => {
    const h = seed();
    for (const who of [peer, admin, orgOwner]) {
      await expect(h.service.get(who, ORG, 'conn-private')).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
      await expect(h.service.validate(who, ORG, 'conn-private')).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
      await expect(h.service.disconnect(who, ORG, 'conn-private')).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
    }
    expect(h.credentials.rows.map((r) => r.id)).toContain('conn-private');
    await expect(h.service.get(owner, ORG, 'conn-private')).resolves.toMatchObject({ id: 'conn-private' });
  });

  describe('connecting one', () => {
    const openai = {
      method: 'GET', url: 'https://api.openai.com/v1/models',
      handle: () => ({ status: 200, body: { data: [{ id: 'gpt-4o' }], object: 'list' } }),
    };

    it('owner: private makes a row only its creator sees, and audits it as private', async () => {
      const h = buildHarness({ routes: [openai] });
      const done = await h.service.connect(owner, ORG, 'openai', { owner: 'private', input: { apiKey: 'sk-private-key-1234' } });
      if (done.pending !== false) throw new Error('expected a connection');
      expect(done.connection).toMatchObject({ owner: 'private', ownerUserId: 'owner-1' });
      const row = h.credentials.rows[0];
      expect(row).toMatchObject({ visibility: 'private', ownerUserId: 'owner-1' });
      expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_connect', details: expect.objectContaining({ owner: 'private' }) }));

      expect((await h.service.list(owner, ORG)).map((c) => c.id)).toEqual([row.id]);
      for (const who of [peer, admin, orgOwner]) {
        expect(await h.service.list(who, ORG)).toEqual([]);
        await expect(h.service.get(who, ORG, row.id)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
      }
    });

    it('owner: user stays Personal: org visibility, still visible to admins', async () => {
      const h = buildHarness({ routes: [openai] });
      const done = await h.service.connect(owner, ORG, 'openai', { owner: 'user', input: { apiKey: 'sk-personal-key-1234' } });
      if (done.pending !== false) throw new Error('expected a connection');
      expect(done.connection).toMatchObject({ owner: 'user', ownerUserId: 'owner-1' });
      expect(h.credentials.rows[0].visibility).toBe('org');
      expect((await h.service.list(admin, ORG)).map((c) => c.id)).toContain(h.credentials.rows[0].id);
    });

    it('a private connect is refused where the org turned member-held keys off', async () => {
      const h = buildHarness({ routes: [openai], org: { settings: { allowUserScopedConnections: false } } });
      await expect(h.service.connect(owner, ORG, 'openai', { owner: 'private', input: { apiKey: 'sk-private-key-1234' } }))
        .rejects.toMatchObject({ response: { code: 'USER_CONNECTIONS_DISABLED' } });
      expect(h.credentials.rows).toHaveLength(0);
    });

    it('a redirect connect carries the private tier through the callback', async () => {
      const h = buildHarness({
        routes: [
          { method: 'POST', url: 'https://openrouter.ai/api/v1/auth/keys', handle: () => ({ status: 200, body: { key: 'sk-or-v1-private-secret' } }) },
          { method: 'GET', url: 'https://openrouter.ai/api/v1/key', handle: () => ({ status: 200, body: { data: { label: 'mine' } } }) },
        ],
      });
      const start = await h.service.connect(owner, ORG, 'openrouter', { owner: 'private' });
      if (!start.pending || !('state' in start)) throw new Error('expected a redirect');
      const connection = await h.service.complete(start.state, 'code-1');
      expect(connection).toMatchObject({ owner: 'private', ownerUserId: 'owner-1' });
      expect(h.credentials.rows[0]).toMatchObject({ visibility: 'private', ownerUserId: 'owner-1' });
      expect(await h.service.list(admin, ORG)).toEqual([]);
    });
  });
});
