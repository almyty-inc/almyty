import { BASIC_AUTH_CONNECTOR, BUILTIN_CONNECTORS, OTHER_SERVICE_CONNECTOR } from '../connector-catalog';
import { schemaViolations, secretFieldsFor, secretFieldsOf } from '../connector-schema';
import { buildHarness, fakeEnvelope, principal } from './test-support';
import { connectionAuthConfig, connectionSecretOf } from '../../credentials/inline-api-auth.helper';
import { ToolAuthService } from '../../tools/services/tool-auth.service';
import { Credential, CredentialType } from '../../../entities/credential.entity';

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

  it('saves a username and password as a credential, the username as its account', async () => {
    const h = buildHarness({ routes: [] });
    const done = await h.service.connect(admin, ORG, 'basic-auth', { input: { username: 'ops', password: 'pw-123456' }, name: 'Weather login' });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection).toMatchObject({ name: 'Weather login', connectorKey: 'basic-auth', accountLabel: 'ops', health: { status: 'valid' } });
    expect(JSON.stringify(done.connection)).not.toContain('pw-123456');
    expect(h.credentials.rows[0].config.password).toMatch(/^encrypted:/);
    expect(h.http.calls).toHaveLength(0);
  });

  it('saves a pasted OAuth 2.0 access token as a sign-in credential', async () => {
    const h = buildHarness({ routes: [] });
    const done = await h.service.connect(admin, ORG, 'oauth2', { input: { accessToken: 'at-123456789' }, name: 'Calendar' });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection).toMatchObject({ connectorKey: 'oauth2', health: { status: 'valid' } });
    expect(h.credentials.rows[0].config.accessToken).toMatch(/^encrypted:/);
  });

  it('refuses an empty key before storing anything', async () => {
    const h = buildHarness({ routes: [] });
    await expect(h.service.connect(admin, ORG, 'other', { input: {}, name: 'Acme CRM' })).rejects.toMatchObject({ response: { code: 'CONNECT_INPUT_INVALID' } });
    expect(h.credentials.rows).toHaveLength(0);
  });

  // Stripe and others take the API key as the basic-auth username with an
  // empty password. Saving one must not need a made-up password, and the
  // key typed as the username is a secret like any other.
  it('saves an API key as the username with the password left empty, kept secret', async () => {
    const h = buildHarness({ routes: [] });
    const done = await h.service.connect(admin, ORG, 'basic-auth', { input: { username: 'sk_test_51Hx', password: '' }, name: 'Stripe' });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection).toMatchObject({ name: 'Stripe', connectorKey: 'basic-auth', accountLabel: null, health: { status: 'valid' } });
    expect(JSON.stringify(done.connection)).not.toContain('sk_test_51Hx');
    const row = h.credentials.rows[0];
    expect(row.config.username).toMatch(/^encrypted:/);
    expect(await fakeEnvelope.decryptForOrg(ORG, row.config.username)).toBe('sk_test_51Hx');
    expect(row.config.password).toBeUndefined();
  });

  it('asks only for the username: the password is optional, and secret when given', () => {
    const schema = BASIC_AUTH_CONNECTOR.connect[0].schema!;
    expect(schema.required).toEqual(['username']);
    expect(schemaViolations({ username: 'sk_test_51Hx' }, schema)).toEqual([]);
    expect(schemaViolations({ password: 'pw' }, schema)).toEqual(['username is required']);
    expect(secretFieldsFor(schema, { username: 'sk_test_51Hx' }).sort()).toEqual(['password', 'username']);
    expect(secretFieldsFor(schema, { username: 'ops', password: 'pw-123456' })).toEqual(['password']);
  });

  it('sends a key-as-username credential as "key:" basic auth, with nothing after the colon', async () => {
    const resolved = connectionAuthConfig({ username: 'sk_test_51Hx' });
    expect(resolved).toMatchObject({ username: 'sk_test_51Hx', password: '' });
    // The key is what an API reading "the connection's key" gets.
    expect(connectionSecretOf({ username: 'sk_test_51Hx' })).toBe('sk_test_51Hx');
    expect(connectionAuthConfig({ username: 'ops', password: 'pw' })).toMatchObject({ username: 'ops', password: 'pw' });

    // An API pointed at the connection, called by a tool.
    const refs = { resolve: jest.fn(async () => ({ config: { username: 'sk_test_51Hx' }, credential: { id: 'c-1', type: CredentialType.BASIC_AUTH } })) };
    const auth = new ToolAuthService({} as any, {} as any, {} as any, refs as any);
    const request: any = {};
    await auth.applyApiAuth(request, { id: 'api-1', authentication: { type: 'basic', config: { connectionId: 'c-1' } } } as any, { organizationId: ORG, userId: 'u-admin' } as any);
    expect(request.headers.Authorization).toBe(`Basic ${Buffer.from('sk_test_51Hx:').toString('base64')}`);

    const credential = Object.assign(new Credential(), { type: CredentialType.BASIC_AUTH, isActive: true, config: { username: 'sk_test_51Hx' } });
    expect(credential.getAuthHeaders()).toEqual({ Authorization: `Basic ${Buffer.from('sk_test_51Hx:').toString('base64')}` });
  });
});
