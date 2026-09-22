import { createHash } from 'crypto';

import { CredentialType } from '../../../entities/credential.entity';
import { buildHarness, fakeEnvelope, principal } from './test-support';

/**
 * The acceptance gate: an OpenRouter PKCE connect end to end against a
 * fixture stand-in for openrouter.ai. Nothing here touches the network.
 */
describe('OpenRouter PKCE connect end to end', () => {
  const ORG = 'org-1';
  const admin = principal('u-admin', ORG, 'admin');
  const member = principal('u-member', ORG, 'member');

  /** A fixture OpenRouter: remembers the challenge it saw, issues a code, exchanges it only with the matching verifier. */
  function openrouter() {
    const issued = new Map<string, string>(); // code -> code_challenge
    const keys = new Map<string, string>(); // key -> label
    let exchanges = 0;
    let codes = 0;
    const routes = [
      {
        method: 'POST', url: 'https://openrouter.ai/api/v1/auth/keys',
        handle: (_url: string, init: RequestInit) => {
          exchanges += 1;
          const body = JSON.parse(String(init.body));
          const challenge = issued.get(body.code);
          if (!challenge) return { status: 400, body: { error: { message: 'invalid code' } } };
          if (body.code_challenge_method !== 'S256') return { status: 400, body: { error: { message: 'bad method' } } };
          if (createHash('sha256').update(String(body.code_verifier)).digest('base64url') !== challenge) return { status: 403, body: { error: { message: 'verifier mismatch' } } };
          issued.delete(body.code);
          const key = `sk-or-v1-${body.code}-secret`;
          keys.set(key, 'almyty (frane)');
          return { status: 200, body: { key } };
        },
      },
      {
        method: 'GET', url: 'https://openrouter.ai/api/v1/key',
        handle: (_url: string, init: RequestInit) => {
          const auth = String((init.headers as Record<string, string>)['Authorization'] ?? '');
          const key = auth.replace(/^Bearer /, '');
          const label = keys.get(key);
          if (!label) return { status: 401, body: { error: { message: 'Missing Authentication header', code: 401 } } };
          return { status: 200, body: { data: { label, usage: 0.42, limit: null, is_free_tier: false } } };
        },
      },
    ];
    return {
      routes,
      /** What the user's browser does on openrouter.ai/auth: approve and get redirected with a code. */
      approve(authorizeUrl: string): { code: string; callback: URL | null } {
        const u = new URL(authorizeUrl);
        const challenge = u.searchParams.get('code_challenge')!;
        codes += 1;
        const code = `code-${codes}`;
        issued.set(code, challenge);
        const cb = u.searchParams.get('callback_url');
        if (!cb) return { code, callback: null };
        const callback = new URL(cb);
        callback.searchParams.set('code', code);
        return { code, callback };
      },
      keys,
      get exchanges() { return exchanges; },
    };
  }

  it('connect -> authorize URL with S256 challenge -> callback exchanges with the verifier -> key stored encrypted -> label from /key -> list masks', async () => {
    const or = openrouter();
    const h = buildHarness({ routes: or.routes });

    const start = await h.service.connect(admin, ORG, 'openrouter', { owner: 'org' });
    expect(start.pending).toBe(true);
    if (!start.pending || !('authorizeUrl' in start)) throw new Error('expected a redirect');
    const authorize = new URL(start.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe('https://openrouter.ai/auth');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.has('client_id')).toBe(false);
    expect(authorize.searchParams.has('state')).toBe(false);
    const callbackUrl = new URL(authorize.searchParams.get('callback_url')!);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe('https://api.test.almyty.com/connections/oauth/callback');
    expect(callbackUrl.searchParams.get('state')).toBe(start.state);
    expect(start.completeWith).toBe('callback');
    expect(start.expiresInSeconds).toBe(600);

    const { callback } = or.approve(start.authorizeUrl);
    const connection = await h.service.handleCallback(Object.fromEntries(callback!.searchParams.entries()));
    expect(or.exchanges).toBe(1);
    const exchange = h.http.calls.find((c) => c.url.endsWith('/auth/keys'))!;
    expect(JSON.parse(String(exchange.init.body))).toMatchObject({ code: 'code-1', code_challenge_method: 'S256', code_verifier: expect.any(String) });
    expect(JSON.parse(String(exchange.init.body))).not.toHaveProperty('client_id');

    expect(connection).toMatchObject({
      connectorKey: 'openrouter',
      connectorDisplayName: 'OpenRouter',
      kind: 'inference',
      owner: 'org',
      ownerUserId: null,
      method: 'oauth2_pkce',
      accountLabel: 'almyty (frane)',
      health: { status: 'valid', error: null },
    });
    expect(connection.name).toBe('OpenRouter (almyty (frane))');
    expect(JSON.stringify(connection)).not.toContain('sk-or-v1');

    const row = h.credentials.rows[0];
    expect(row.connectorKey).toBe('openrouter');
    expect(row.type).toBe(CredentialType.API_KEY);
    expect(row.config.apiKey).toMatch(/^encrypted:/);
    expect(await fakeEnvelope.decryptForOrg(ORG, row.config.apiKey)).toBe('sk-or-v1-code-1-secret');
    expect(row.healthStatus).toBe('valid');
    expect(row.healthCheckedAt).toBeInstanceOf(Date);
    expect(row.metadata).toMatchObject({ connectMethod: 'oauth2_pkce', connectorKind: 'inference' });

    const listed = await h.service.list(member, ORG);
    expect(listed).toHaveLength(1);
    expect(listed[0].accountLabel).toBe('almyty (frane)');
    expect(JSON.stringify(listed)).not.toMatch(/sk-or-v1|apiKey|encrypted:/);
    expect(await h.service.get(member, ORG, connection.id)).toMatchObject({ id: connection.id, accountLabel: 'almyty (frane)' });

    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_connect', resourceType: 'connection', details: expect.objectContaining({ connectorKey: 'openrouter', method: 'oauth2_pkce', ok: true }) }));
  });

  it('the state is single use and unknown states are refused', async () => {
    const or = openrouter();
    const h = buildHarness({ routes: or.routes });
    const start = await h.service.connect(admin, ORG, 'openrouter', {});
    if (!start.pending || !('authorizeUrl' in start)) throw new Error('expected a redirect');
    const { callback } = or.approve(start.authorizeUrl);
    const query = Object.fromEntries(callback!.searchParams.entries());
    await h.service.handleCallback(query);
    await expect(h.service.handleCallback(query)).rejects.toMatchObject({ response: { code: 'CONNECT_STATE_INVALID' } });
    await expect(h.service.complete('nope', 'code')).rejects.toMatchObject({ response: { code: 'CONNECT_STATE_INVALID' } });
    expect(h.credentials.rows).toHaveLength(1);
  });

  it('a wrong verifier (or a stolen code) never yields a connection', async () => {
    const or = openrouter();
    const h = buildHarness({ routes: or.routes });
    const first = await h.service.connect(admin, ORG, 'openrouter', {});
    const second = await h.service.connect(admin, ORG, 'openrouter', {});
    if (!first.pending || !('authorizeUrl' in first) || !second.pending || !('authorizeUrl' in second)) throw new Error('expected redirects');
    // Code issued against the first challenge, presented with the second state (second verifier).
    const { code } = or.approve(first.authorizeUrl);
    await expect(h.service.complete(second.state, code)).rejects.toMatchObject({ response: { code: 'CONNECT_EXCHANGE_FAILED', message: expect.stringContaining('verifier mismatch') } });
    expect(h.credentials.rows).toHaveLength(0);
  });

  it('headless mode omits the callback so OpenRouter prints the code, and POST /complete finishes it', async () => {
    const or = openrouter();
    const h = buildHarness({ routes: or.routes });
    const start = await h.service.connect(member, ORG, 'openrouter', { owner: 'user', mode: 'headless' });
    if (!start.pending || !('authorizeUrl' in start)) throw new Error('expected a redirect');
    expect(start.completeWith).toBe('code');
    expect(new URL(start.authorizeUrl).searchParams.has('callback_url')).toBe(false);
    const { code, callback } = or.approve(start.authorizeUrl);
    expect(callback).toBeNull();
    const connection = await h.service.complete(start.state, code);
    expect(connection).toMatchObject({ owner: 'user', ownerUserId: 'u-member', health: { status: 'valid' } });
  });

  it('a provider that denies the request clears the state and reports CONNECT_DENIED', async () => {
    const or = openrouter();
    const h = buildHarness({ routes: or.routes });
    const start = await h.service.connect(admin, ORG, 'openrouter', {});
    if (!start.pending || !('authorizeUrl' in start)) throw new Error('expected a redirect');
    await expect(h.service.handleCallback({ state: start.state, error: 'access_denied', error_description: 'user said no' })).rejects.toMatchObject({ response: { code: 'CONNECT_DENIED', message: 'user said no' } });
    await expect(h.service.complete(start.state, 'x')).rejects.toMatchObject({ response: { code: 'CONNECT_STATE_INVALID' } });
  });

  it('rotate on an OAuth connection issues a new authorize URL and replaces the key in place', async () => {
    const or = openrouter();
    const h = buildHarness({ routes: or.routes });
    const start = await h.service.connect(admin, ORG, 'openrouter', {});
    if (!start.pending || !('authorizeUrl' in start)) throw new Error('expected a redirect');
    const first = await h.service.handleCallback(Object.fromEntries(or.approve(start.authorizeUrl).callback!.searchParams.entries()));

    const rotate = await h.service.rotate(admin, ORG, first.id, {});
    if (!rotate.pending || !('authorizeUrl' in rotate)) throw new Error('expected a redirect');
    const rotated = await h.service.handleCallback(Object.fromEntries(or.approve(rotate.authorizeUrl).callback!.searchParams.entries()));
    expect(rotated.id).toBe(first.id);
    expect(h.credentials.rows).toHaveLength(1);
    expect(await fakeEnvelope.decryptForOrg(ORG, h.credentials.rows[0].config.apiKey)).toBe('sk-or-v1-code-2-secret');
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_rotate', resourceId: first.id }));
  });

  it('OpenRouter also accepts a pasted API key, validated against /key', async () => {
    const or = openrouter();
    or.keys.set('sk-or-v1-pasted', 'pasted key');
    const h = buildHarness({ routes: or.routes });
    const done = await h.service.connect(admin, ORG, 'openrouter', { method: 'api_key', input: { apiKey: 'sk-or-v1-pasted' } });
    expect(done.pending).toBe(false);
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection).toMatchObject({ method: 'api_key', accountLabel: 'pasted key', health: { status: 'valid' } });
  });
});
