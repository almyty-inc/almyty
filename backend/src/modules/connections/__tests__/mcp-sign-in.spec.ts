import { NotFoundException } from '@nestjs/common';

import { BUILTIN_CONNECTORS } from '../connector-catalog';
import { validateConnectorDefinition } from '../connector-schema';
import { CredentialSignInController } from '../connections.controller';
import { CredentialType } from '../../../entities/credential.entity';
import { buildHarness, fakeEnvelope, principal } from './test-support';
import { ISSUER, SERVER, WorldOptions, world } from './mcp-oauth-world';
import { snapshotEnv } from '../../../test/env';

/**
 * Signing in to an OAuth-protected MCP server from Credentials (owner
 * decision 11), end to end against a scripted MCP server and authorization
 * server. Nothing touches the network.
 *
 * What is pinned: discovery from the 401 (then the well-known paths), who
 * almyty is there (a client id entered by hand, the client metadata
 * document, a dynamic registration, in that order), PKCE S256 and
 * `resource` on both legs, `iss` on the way back, and the tokens kept only
 * in the credential row, encrypted, with the issuer that issued them.
 */
const ORG = 'org-1';
const admin = principal('u-admin', ORG, 'admin');
const API = 'https://api.test.almyty.com';
const CALLBACK = `${API}/credentials/oauth/callback`;

async function startSignIn(h: ReturnType<typeof buildHarness>, input: Record<string, unknown> = { serverUrl: SERVER }) {
  const start = await h.service.connect(admin, ORG, 'mcp-custom', { method: 'oauth2_pkce', owner: 'org', input });
  if (!start.pending || !('authorizeUrl' in start)) throw new Error('expected a redirect');
  return start;
}

describe('signing in to an MCP server (Credentials)', () => {
  const restore = snapshotEnv('MCP_CLIENT_CIMD_ENABLED');
  afterEach(restore);

  it('discovers the sign-in from the 401, registers almyty, and stores the tokens encrypted with their issuer', async () => {
    const w = world();
    const h = buildHarness({ routes: w.routes });
    const start = await startSignIn(h);

    const authorize = new URL(start.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'dcr-client-1',
      redirect_uri: CALLBACK,
      state: start.state,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
      resource: SERVER,
      scope: 'files:read',
    });
    expect(w.registrations).toEqual([
      expect.objectContaining({
        client_name: 'almyty',
        redirect_uris: [CALLBACK],
        application_type: 'web',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        scope: 'files:read',
      }),
    ]);

    const view = await h.service.handleCallback(w.approve(start.authorizeUrl));
    expect(view).toMatchObject({ connectorKey: 'mcp-custom', method: 'oauth2_pkce', accountLabel: 'Docs MCP', health: { status: 'valid' }, scopesGranted: ['files:read'] });

    const row = h.credentials.rows[0];
    expect(row.type).toBe(CredentialType.OAUTH2);
    expect(row.config).toMatchObject({
      serverUrl: SERVER,
      oauthIssuer: ISSUER,
      oauthResource: SERVER,
      oauthClientId: 'dcr-client-1',
      oauthRegistration: 'dcr',
      tokenEndpoint: `${ISSUER}/token`,
      tokenType: 'Bearer',
    });
    expect(row.config.accessToken).toMatch(/^encrypted:/);
    expect(row.config.refreshToken).toMatch(/^encrypted:/);
    expect(await fakeEnvelope.decryptForOrg(ORG, row.config.accessToken)).toBe('at-1');
    expect(new Date(row.expiresAt as any).getTime()).toBeGreaterThan(Date.now() + 3_500_000);

    const exchange = w.tokenRequests[0].fields;
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('resource')).toBe(SERVER);
    expect(exchange.get('client_id')).toBe('dcr-client-1');
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a callback from another issuer, or without iss when the server promised it', async () => {
    const w = world();
    const h = buildHarness({ routes: w.routes });
    const first = await startSignIn(h);
    await expect(h.service.handleCallback(w.approve(first.authorizeUrl, 'https://evil.example.com'))).rejects.toMatchObject({
      response: { code: 'MCP_SIGN_IN_FAILED', message: expect.stringContaining('evil.example.com') },
    });
    const second = await startSignIn(h);
    await expect(h.service.handleCallback(w.approve(second.authorizeUrl, null))).rejects.toMatchObject({
      response: { code: 'MCP_SIGN_IN_FAILED', message: expect.stringContaining('iss') },
    });
    expect(w.tokenRequests).toHaveLength(0);
    expect(h.credentials.rows).toHaveLength(0);
  });

  it('accepts a callback without iss from a server that does not send it', async () => {
    const w = world({ issParameter: false });
    const h = buildHarness({ routes: w.routes });
    const start = await startSignIn(h);
    await expect(h.service.handleCallback(w.approve(start.authorizeUrl, null))).resolves.toMatchObject({ health: { status: 'valid' } });
  });

  it('names itself by its client metadata document where the server takes one, and registers nothing', async () => {
    const w = world({ cimd: true });
    const h = buildHarness({ routes: w.routes });
    const start = await startSignIn(h);
    expect(new URL(start.authorizeUrl).searchParams.get('client_id')).toBe(`${API}/credentials/oauth/client-metadata.json`);
    expect(w.registrations).toHaveLength(0);
    await h.service.handleCallback(w.approve(start.authorizeUrl));
    expect(h.credentials.rows[0].config.oauthRegistration).toBe('cimd');
  });

  it('registers instead when the document cannot be served over https, or is turned off', async () => {
    const overHttp = world({ cimd: true });
    await startSignIn(buildHarness({ routes: overHttp.routes, env: { PUBLIC_API_URL: 'http://localhost:4000' } }));
    expect(overHttp.registrations).toHaveLength(1);

    process.env.MCP_CLIENT_CIMD_ENABLED = 'false';
    const off = world({ cimd: true });
    await startSignIn(buildHarness({ routes: off.routes }));
    expect(off.registrations).toHaveLength(1);
  });

  it('uses a client id entered by hand first, keeps its secret encrypted, and authenticates with it', async () => {
    const w = world({ cimd: true });
    const h = buildHarness({ routes: w.routes });
    const start = await startSignIn(h, { serverUrl: SERVER, clientId: 'handed-out', clientSecret: 's3cret' });
    expect(new URL(start.authorizeUrl).searchParams.get('client_id')).toBe('handed-out');
    expect(w.registrations).toHaveLength(0);
    // The pending state never holds the secret in the clear.
    const raw = JSON.stringify((h.store as any).entries.get(start.state).payload);
    expect(raw).not.toContain('s3cret');

    await h.service.handleCallback(w.approve(start.authorizeUrl));
    const exchange = w.tokenRequests[0];
    expect(exchange.headers.Authorization).toBe(`Basic ${Buffer.from('handed-out:s3cret').toString('base64')}`);
    expect(exchange.fields.has('client_secret')).toBe(false);
    expect(h.credentials.rows[0].config.clientSecret).toMatch(/^encrypted:/);
  });

  it('finds the metadata on the well-known path when the 401 does not name it', async () => {
    const w = world({ challenge: false });
    const h = buildHarness({ routes: w.routes });
    const start = await startSignIn(h);
    expect(new URL(start.authorizeUrl).searchParams.get('resource')).toBe(SERVER);
    // No scope in a challenge: everything the server lists.
    expect(new URL(start.authorizeUrl).searchParams.get('scope')).toBe('files:read files:write');
  });

  it.each([
    ['metadata naming another resource', { resource: 'https://other.example.com/mcp' }, 'not for this server'],
    ['an authorization server claiming another issuer', { asIssuer: 'https://impostor.example.com' }, 'impostor.example.com'],
    ['no PKCE with S256', { pkce: ['plain'] }, 'S256'],
    ['no registration and no client id', { registration: false }, 'client id'],
  ])('refuses a server with %s', async (_label, opts, message) => {
    const h = buildHarness({ routes: world(opts as WorldOptions).routes });
    await expect(h.service.connect(admin, ORG, 'mcp-custom', { method: 'oauth2_pkce', owner: 'org', input: { serverUrl: SERVER } })).rejects.toMatchObject({
      response: { code: 'MCP_SIGN_IN_FAILED', message: expect.stringContaining(message) },
    });
  });

  it('says a server that does not ask for sign-in can be added without one', async () => {
    const h = buildHarness({ routes: [{ method: 'POST', url: SERVER, handle: () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }) }] });
    await expect(h.service.connect(admin, ORG, 'mcp-custom', { method: 'oauth2_pkce', owner: 'org', input: { serverUrl: SERVER } })).rejects.toMatchObject({
      response: { message: expect.stringContaining('did not ask for sign-in') },
    });
  });

  it('signs in again with what the connection has, keeping the row', async () => {
    const w = world();
    const h = buildHarness({ routes: w.routes });
    await h.service.handleCallback(w.approve((await startSignIn(h)).authorizeUrl));
    const id = h.credentials.rows[0].id;

    const again = await h.service.rotate(admin, ORG, id, {});
    if (!again.pending || !('authorizeUrl' in again)) throw new Error('expected a redirect');
    expect(new URL(again.authorizeUrl).searchParams.get('resource')).toBe(SERVER);
    await h.service.handleCallback(w.approve(again.authorizeUrl));
    expect(h.credentials.rows).toHaveLength(1);
    expect(await fakeEnvelope.decryptForOrg(ORG, h.credentials.rows[0].config.accessToken)).toBe('at-2');
  });

  it('revokes at the issuer when the connection is removed', async () => {
    const w = world();
    const h = buildHarness({ routes: w.routes });
    await h.service.handleCallback(w.approve((await startSignIn(h)).authorizeUrl));
    const outcome = await h.service.revokeAtProvider(h.credentials.rows[0] as any, 'u-admin');
    expect(outcome).toMatchObject({ attempted: true, revoked: true, via: 'oauth2' });
    const revoked = h.http.calls.filter((c) => c.url === `${ISSUER}/revoke`).map((c) => new URLSearchParams(String(c.init.body)).get('token_type_hint'));
    expect(revoked).toEqual(['refresh_token', 'access_token']);
  });
});

describe('the MCP sign-in method in the catalog', () => {
  const base = { key: 'org-mcp', kind: 'mcp', displayName: 'Org MCP', validation: { kind: 'mcp_initialize' } };
  const signIn = {
    type: 'oauth2_pkce',
    schema: { type: 'object', properties: { serverUrl: { type: 'string' } }, required: ['serverUrl'] },
    oauth: { authorizeUrl: '', tokenUrl: '', pkce: true, discover: 'mcp' },
  };

  it('is offered on the MCP server connector, after the token, and passes the catalog rules', () => {
    const connector = BUILTIN_CONNECTORS.find((c) => c.key === 'mcp-custom')!;
    expect(connector.connect.map((m) => m.type)).toEqual(['api_key', 'oauth2_pkce']);
    expect(connector.connect[1].oauth).toMatchObject({ discover: 'mcp', pkce: true });
    expect(validateConnectorDefinition(connector)).toEqual([]);
  });

  it('needs PKCE, a serverUrl field and the one discovery there is', () => {
    expect(validateConnectorDefinition({ ...base, connect: [signIn] })).toEqual([]);
    expect(validateConnectorDefinition({ ...base, connect: [{ ...signIn, oauth: { ...signIn.oauth, discover: 'oidc' } }] })).toContain('connect[0]: oauth.discover must be "mcp"');
    expect(validateConnectorDefinition({ ...base, connect: [{ ...signIn, type: 'oauth2_code' }] })).toContain('connect[0]: oauth.discover needs oauth2_pkce');
    expect(validateConnectorDefinition({ ...base, connect: [{ ...signIn, schema: { type: 'object', properties: { url: { type: 'string' } } } }] })).toContain('connect[0]: oauth.discover needs a serverUrl field');
  });
});

describe('the almyty client metadata document', () => {
  const restore = snapshotEnv('MCP_CLIENT_CIMD_ENABLED', 'MCP_CLIENT_CIMD_MAX_AGE_SECONDS');
  afterEach(restore);

  function serve(env: Record<string, string> = {}) {
    const h = buildHarness({ env });
    const controller = new CredentialSignInController(h.service, { get: (k: string) => ({ FRONTEND_URL: 'https://app.test.almyty.com', ...env } as Record<string, string>)[k] } as any, h.mcpOAuth);
    const res: any = { headers: {}, setHeader(k: string, v: string) { this.headers[k] = v; }, status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    const req: any = { protocol: 'https', get: () => 'api.test.almyty.com' };
    return { controller, res, req };
  }

  it('is served at the URL it names as client id, with the callback, cacheable for MCP_CLIENT_CIMD_MAX_AGE_SECONDS', () => {
    process.env.MCP_CLIENT_CIMD_MAX_AGE_SECONDS = '900';
    const { controller, res, req } = serve();
    controller.clientMetadata(req, res);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({
      client_id: `${API}/credentials/oauth/client-metadata.json`,
      client_name: 'almyty',
      client_uri: 'https://app.test.almyty.com',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    });
    expect(res.headers['Cache-Control']).toBe('public, max-age=900');
  });

  it('is not there when MCP_CLIENT_CIMD_ENABLED is false', () => {
    process.env.MCP_CLIENT_CIMD_ENABLED = 'false';
    const { controller, res, req } = serve();
    expect(() => controller.clientMetadata(req, res)).toThrow(NotFoundException);
  });
});
