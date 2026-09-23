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
});
