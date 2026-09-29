import { BUILTIN_CONNECTORS, OTHER_SERVICE_CONNECTOR } from '../connector-catalog';
import { secretFieldsOf } from '../connector-schema';
import { buildHarness, fakeEnvelope, principal } from './test-support';

/**
 * "Other service" on the Connections page: a name and one secret box, for
 * any key the catalog has no entry for. It is a connection like the rest
 * (grants, audit, encryption), and nothing is called to check it.
 */
describe('other service connector', () => {
  const ORG = 'org-1';
  const admin = principal('u-admin', ORG, 'admin');

  it('is a built-in with one secret field and a shape-only check', () => {
    expect(BUILTIN_CONNECTORS.find((c) => c.key === 'other')).toBe(OTHER_SERVICE_CONNECTOR);
    const method = OTHER_SERVICE_CONNECTOR.connect[0];
    expect(OTHER_SERVICE_CONNECTOR.connect).toHaveLength(1);
    expect(method.type).toBe('api_key');
    expect(Object.keys(method.schema!.properties)).toEqual(['apiKey']);
    expect(secretFieldsOf(method.schema)).toEqual(['apiKey']);
    expect(method.schema!.required).toEqual(['apiKey']);
    expect(OTHER_SERVICE_CONNECTOR.validation).toEqual({ kind: 'format' });
  });

  it('saves the key under the given name, encrypted, without calling anyone', async () => {
    const h = buildHarness({ routes: [] });
    const done = await h.service.connect(admin, ORG, 'other', { input: { apiKey: 'acme-secret-123' }, name: 'Acme CRM' });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection).toMatchObject({ name: 'Acme CRM', connectorKey: 'other', owner: 'org', health: { status: 'valid' } });
    expect(JSON.stringify(done.connection)).not.toContain('acme-secret-123');
    expect(h.http.calls).toHaveLength(0);
    const row = h.credentials.rows[0];
    expect(row.config.apiKey).toMatch(/^encrypted:/);
    expect(await fakeEnvelope.decryptForOrg(ORG, row.config.apiKey)).toBe('acme-secret-123');
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_connect' }));
  });

  it('refuses an empty key before storing anything', async () => {
    const h = buildHarness({ routes: [] });
    await expect(h.service.connect(admin, ORG, 'other', { input: {}, name: 'Acme CRM' })).rejects.toMatchObject({ response: { code: 'CONNECT_INPUT_INVALID' } });
    expect(h.credentials.rows).toHaveLength(0);
  });
});
