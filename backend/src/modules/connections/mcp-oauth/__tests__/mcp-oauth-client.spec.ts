import { CredentialType } from '../../../../entities/credential.entity';
import { McpOAuthClientService } from '../mcp-oauth-client.service';
import {
  authorizationServerMetadataUrls,
  checkAuthorizationServer,
  checkProtectedResource,
  parseWwwAuthenticate,
  protectedResourceMetadataUrls,
  scopeToRequest,
} from '../mcp-oauth-discovery';
import { parseCimdDocument } from '../../../mcp/services/mcp-oauth-cimd.service';
import { fakeEnvelope, fakeRepo, fixtureHttp } from '../../__tests__/test-support';
import { ISSUER, SERVER, world } from '../../__tests__/mcp-oauth-world';
import { snapshotEnv } from '../../../../test/env';

/**
 * The MCP OAuth client below the Connections flow: the discovery rules, the
 * outbound guard, and keeping a sign-in usable -- refreshed before it
 * expires, renewed on a 401, and never sent to an authorization server
 * other than the one that issued it (SEP-2352).
 */
describe('MCP sign-in discovery rules', () => {
  it('reads the Bearer challenge among others, quoted or bare', () => {
    expect(parseWwwAuthenticate('Basic realm="x", Bearer resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="read write"')).toEqual({
      resourceMetadata: 'https://a.example/.well-known/oauth-protected-resource',
      scope: 'read write',
    });
    expect(parseWwwAuthenticate('Bearer error=invalid_token, scope=read')).toEqual({ error: 'invalid_token', scope: 'read' });
    expect(parseWwwAuthenticate('Bearer scope="a", Basic realm="other"')).toEqual({ scope: 'a' });
    expect(parseWwwAuthenticate('Basic realm="x"')).toBeNull();
    expect(parseWwwAuthenticate(null)).toBeNull();
  });

  it('looks for the resource metadata with the path first, and for the issuer per RFC 8414 then OpenID Connect', () => {
    expect(protectedResourceMetadataUrls('https://mcp.example.com/v1/mcp/')).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    ]);
    expect(protectedResourceMetadataUrls('https://mcp.example.com')).toEqual(['https://mcp.example.com/.well-known/oauth-protected-resource']);
    expect(authorizationServerMetadataUrls('https://auth.example.com/tenant1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ]);
    expect(authorizationServerMetadataUrls('https://auth.example.com/')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ]);
  });

  it('takes resource metadata only for the server itself', () => {
    const doc = { resource: 'https://mcp.example.com/v1', authorization_servers: ['https://auth.example.com'] };
    expect(checkProtectedResource(doc, 'https://mcp.example.com/v1/mcp')).toMatchObject({ resource: 'https://mcp.example.com/v1' });
    expect(checkProtectedResource(doc, 'https://mcp.example.com/v10')).toMatch(/not for this server/);
    expect(checkProtectedResource({ ...doc, resource: 'https://evil.example.com/v1' }, 'https://mcp.example.com/v1')).toMatch(/not for this server/);
    expect(checkProtectedResource({ resource: 'https://mcp.example.com/v1' }, 'https://mcp.example.com/v1')).toMatch(/no authorization server/);
    expect(checkProtectedResource([], 'https://mcp.example.com/v1')).toMatch(/not a JSON object/);
  });

  it('takes authorization server metadata only for the issuer asked, with PKCE S256', () => {
    const doc = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
    expect(checkAuthorizationServer(doc, 'https://auth.example.com/')).toMatchObject({ clientIdMetadataDocumentSupported: true, issParameterSupported: true, registrationEndpoint: null });
    expect(checkAuthorizationServer({ ...doc, issuer: 'https://auth.example.com/other' }, 'https://auth.example.com')).toMatch(/issuer/);
    expect(checkAuthorizationServer({ ...doc, code_challenge_methods_supported: undefined }, 'https://auth.example.com')).toMatch(/S256/);
    expect(checkAuthorizationServer({ ...doc, token_endpoint: 'ftp://x' }, 'https://auth.example.com')).toMatch(/token endpoint/);
  });

  it('asks for the scope the server named, else everything it lists, unless one was entered', () => {
    const resource = { resource: SERVER, authorizationServers: [ISSUER], scopesSupported: ['a', 'b'] };
    expect(scopeToRequest({ scope: 'a' }, resource)).toBe('a');
    expect(scopeToRequest(null, resource)).toBe('a b');
    expect(scopeToRequest({ scope: 'a' }, resource, 'c')).toBe('c');
    expect(scopeToRequest(null, { ...resource, scopesSupported: [] })).toBeNull();
  });
});

describe('McpOAuthClientService', () => {
  const restore = snapshotEnv('MCP_CLIENT_OAUTH_MAX_BYTES', 'MCP_ALLOW_PRIVATE_URLS', 'MCP_CLIENT_OAUTH_REFRESH_SKEW_SECONDS', 'MCP_CLIENT_NAME');
  afterEach(restore);

  function setup(routes = world().routes) {
    const credentials = fakeRepo<any>();
    const http = fixtureHttp(routes);
    const service = new McpOAuthClientService(credentials as any, fakeEnvelope, http.http);
    return { credentials, http, service };
  }

  /** A stored sign-in, as the Connections flow leaves it. */
  async function signedIn(credentials: ReturnType<typeof fakeRepo<any>>, over: Record<string, any> = {}) {
    const row: Record<string, any> = {
      id: 'cred-1',
      organizationId: 'org-1',
      type: CredentialType.OAUTH2,
      connectorKey: 'mcp-custom',
      expiresAt: new Date(Date.now() - 1_000),
      healthStatus: 'valid',
      config: {
        serverUrl: SERVER,
        accessToken: await fakeEnvelope.encryptForOrg('org-1', 'at-old'),
        refreshToken: await fakeEnvelope.encryptForOrg('org-1', 'rt-1'),
        tokenType: 'Bearer',
        tokenEndpoint: `${ISSUER}/token`,
        oauthIssuer: ISSUER,
        oauthResource: SERVER,
        oauthClientId: 'dcr-client-1',
        oauthTokenAuth: 'none',
      },
      ...over,
    };
    credentials.rows.push(row);
    return row;
  }

  it('refreshes a sign-in that has expired, at the issuer, with resource, and stores the new tokens encrypted', async () => {
    const w = world();
    const { credentials, http, service } = setup(w.routes);
    const row = await signedIn(credentials);
    const tokenRoute = w.routes.find((r) => String(r.url).includes('token'))!;
    const original = tokenRoute.handle;
    tokenRoute.handle = (url, init) => {
      const fields = new URLSearchParams(String(init.body));
      if (fields.get('refresh_token') === 'rt-1') {
        expect(fields.get('grant_type')).toBe('refresh_token');
        expect(fields.get('resource')).toBe(SERVER);
        expect(fields.get('client_id')).toBe('dcr-client-1');
        return { status: 200, body: { access_token: 'at-new', refresh_token: 'rt-2', token_type: 'bearer', expires_in: 600 } };
      }
      return original(url, init);
    };

    await expect(service.ensureFresh('org-1', 'cred-1')).resolves.toEqual({ status: 'refreshed' });
    expect(await fakeEnvelope.decryptForOrg('org-1', row.config.accessToken)).toBe('at-new');
    expect(await fakeEnvelope.decryptForOrg('org-1', row.config.refreshToken)).toBe('rt-2');
    expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(Date.now() + 590_000);
    expect(row.healthStatus).toBe('valid');
    expect(http.calls.map((c) => c.url)).toEqual([`${ISSUER}/token`]);
  });

  it('leaves a sign-in that is not due alone, and anything that is not an MCP sign-in', async () => {
    const { credentials, http, service } = setup();
    await signedIn(credentials, { expiresAt: new Date(Date.now() + 3_600_000) });
    await expect(service.ensureFresh('org-1', 'cred-1')).resolves.toEqual({ status: 'fresh' });
    credentials.rows.push({ id: 'cred-2', organizationId: 'org-1', type: CredentialType.BEARER_TOKEN, connectorKey: 'mcp-custom', config: { token: 'x' } });
    await expect(service.ensureFresh('org-1', 'cred-2')).resolves.toEqual({ status: 'not_mcp_oauth' });
    await expect(service.ensureFresh('org-2', 'cred-1')).resolves.toEqual({ status: 'not_mcp_oauth' });
    await expect(service.ensureFresh('org-1', null)).resolves.toEqual({ status: 'not_mcp_oauth' });
    expect(http.calls).toHaveLength(0);
  });

  it('refreshes ahead of expiry by MCP_CLIENT_OAUTH_REFRESH_SKEW_SECONDS', async () => {
    process.env.MCP_CLIENT_OAUTH_REFRESH_SKEW_SECONDS = '300';
    const { credentials, service } = setup();
    await signedIn(credentials, { expiresAt: new Date(Date.now() + 120_000) });
    // Due (inside the skew); the scripted issuer does not know rt-1, so the sign-in must be made again.
    await expect(service.ensureFresh('org-1', 'cred-1')).resolves.toMatchObject({ status: 'reconnect' });
  });

  it('asks to sign in again when the issuer refuses the refresh token, and says so on the connection', async () => {
    const { credentials, service } = setup();
    const row = await signedIn(credentials);
    const out = await service.ensureFresh('org-1', 'cred-1');
    expect(out).toMatchObject({ status: 'reconnect', error: expect.stringContaining('Sign in again') });
    expect(row.healthStatus).toBe('expired');
    expect(row.healthError).toMatch(/invalid_grant/);
  });

  it('asks to sign in again when there is no refresh token', async () => {
    const { credentials, http, service } = setup();
    const row = await signedIn(credentials);
    delete row.config.refreshToken;
    await expect(service.ensureFresh('org-1', 'cred-1')).resolves.toMatchObject({ status: 'reconnect' });
    expect(http.calls).toHaveLength(0);
  });

  it('keeps the sign-in when the issuer is down, so a passing outage does not end it', async () => {
    const w = world();
    const tokenRoute = w.routes.find((r) => String(r.url).includes('token'))!;
    tokenRoute.handle = () => ({ status: 503, body: { error: 'temporarily_unavailable' } });
    const { credentials, service } = setup(w.routes);
    const row = await signedIn(credentials);
    await expect(service.ensureFresh('org-1', 'cred-1')).resolves.toMatchObject({ status: 'unavailable' });
    expect(row.healthStatus).toBe('valid');
  });

  it('on a 401, sends no token to a server that now signs in elsewhere (SEP-2352)', async () => {
    const w = world();
    const prm = w.routes.find((r) => String(r.url).includes('oauth-protected-resource\\/mcp'))!;
    prm.handle = () => ({ status: 200, body: { resource: SERVER, authorization_servers: ['https://new-auth.example.com'] } });
    const { credentials, http, service } = setup(w.routes);
    const row = await signedIn(credentials, { expiresAt: new Date(Date.now() + 3_600_000) });

    const out = await service.ensureFresh('org-1', 'cred-1', { force: true });
    expect(out).toMatchObject({ status: 'reconnect', error: expect.stringContaining('new-auth.example.com') });
    expect(row.healthStatus).toBe('expired');
    expect(http.calls.some((c) => c.url.includes('/token'))).toBe(false);
  });

  it('shares one refresh between callers that ask at once', async () => {
    const w = world();
    let refreshes = 0;
    const tokenRoute = w.routes.find((r) => String(r.url).includes('token'))!;
    tokenRoute.handle = async () => {
      refreshes += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { status: 200, body: { access_token: `at-${refreshes}`, refresh_token: `rt-${refreshes + 1}`, token_type: 'Bearer', expires_in: 600 } };
    };
    const { credentials, service } = setup(w.routes);
    await signedIn(credentials);
    const both = await Promise.all([service.ensureFresh('org-1', 'cred-1'), service.ensureFresh('org-1', 'cred-1')]);
    expect(both).toEqual([{ status: 'refreshed' }, { status: 'refreshed' }]);
    expect(refreshes).toBe(1);
  });

  it('refuses a private address unless MCP_ALLOW_PRIVATE_URLS is on, before any request', async () => {
    const { http, service } = setup([]);
    await expect(service.discover('http://127.0.0.1:4000/acme/docs')).rejects.toMatchObject({ response: { code: 'MCP_SIGN_IN_FAILED' } });
    await expect(service.discover('http://localhost:4000/acme/docs')).rejects.toMatchObject({ response: { code: 'MCP_SIGN_IN_FAILED' } });
    expect(http.calls).toHaveLength(0);
  });

  it('reads at most MCP_CLIENT_OAUTH_MAX_BYTES of an answer', async () => {
    process.env.MCP_CLIENT_OAUTH_MAX_BYTES = '1024';
    const w = world();
    const prm = w.routes.find((r) => String(r.url).includes('oauth-protected-resource\\/mcp'))!;
    prm.handle = () => ({ status: 200, body: { resource: SERVER, authorization_servers: [ISSUER], padding: 'x'.repeat(5_000) } });
    const { service } = setup(w.routes);
    await expect(service.discover(SERVER)).rejects.toMatchObject({ response: { message: expect.stringContaining('more than 1024 bytes') } });
  });

  it('serves a client metadata document an almyty authorization server accepts', () => {
    process.env.MCP_CLIENT_NAME = 'Northwind almyty';
    const { service } = setup([]);
    const api = 'https://api.almyty.com';
    const doc = service.clientMetadataDocument(api, `${api}/credentials/oauth/callback`, 'https://app.almyty.com');
    expect(doc).toMatchObject({ client_id: `${api}/credentials/oauth/client-metadata.json`, client_name: 'Northwind almyty', token_endpoint_auth_method: 'none' });
    const parsed = parseCimdDocument(`${api}/credentials/oauth/client-metadata.json`, JSON.stringify(doc));
    expect(parsed).toMatchObject({ clientName: 'Northwind almyty', redirectUris: [`${api}/credentials/oauth/callback`], applicationType: 'web' });
  });
});
