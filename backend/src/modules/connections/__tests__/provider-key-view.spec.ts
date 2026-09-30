import { Credential, CredentialType } from '../../../entities/credential.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { buildHarness, principal } from './test-support';

/**
 * The key a provider connection made for itself says which connection it
 * belongs to, so Credentials opens that connection's page (its key, its
 * models and who can use it) instead of a key page of its own.
 */
describe('a provider connection key on Credentials', () => {
  const ORG = 'org-1';
  const admin = principal('admin-1', ORG, OrganizationRole.ADMIN);

  function row(id: string, metadata: Record<string, unknown> | null) {
    return Object.assign(new Credential(), {
      id, organizationId: ORG, name: id, type: CredentialType.API_KEY,
      connectorKey: 'openai', config: { apiKey: 'sk' }, visibility: 'org', teamId: null,
      ownerUserId: 'admin-1', isActive: true, metadata, createdAt: new Date(), updatedAt: new Date(),
    });
  }

  it('names the connection it belongs to, and nothing for any other key', async () => {
    const h = buildHarness();
    h.credentials.rows.push(
      row('managed', { managedBy: { kind: 'llm_provider', id: 'prov-1' } }),
      row('usage', { managedBy: { kind: 'llm_provider_usage', id: 'prov-1' } }),
      row('plain', null),
    );
    const byId = Object.fromEntries((await h.service.list(admin, ORG)).map((c) => [c.id, c.providerId]));
    expect(byId).toEqual({ managed: 'prov-1', usage: null, plain: null });
  });
});
