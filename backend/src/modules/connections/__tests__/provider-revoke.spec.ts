import { buildHarness, FixtureRoute, principal } from './test-support';

/**
 * Revoking a connection's grant at its provider (ConnectionsService.
 * revokeAtProvider), which disconnecting and offboarding both use.
 *
 * An OAuth connector can now declare an RFC 7009 `revocationUrl`. The
 * refresh token is revoked first (the RFC has the server end the access
 * tokens it issued along with it), then the access token, authenticated
 * the way the token exchange was. The provider's answer is reported and
 * never stops the local removal.
 */
describe('revoking a connection at its provider', () => {
  const ORG = 'org-1';
  const admin = principal('u-admin', ORG, 'admin');
  const REVOKE = 'https://auth.acme.example.com/oauth/revoke';
  const env = {
    CONNECTIONS_OAUTH_ACME_OAUTH_CLIENT_ID: 'acme-client',
    CONNECTIONS_OAUTH_ACME_OAUTH_CLIENT_SECRET: 'acme-client-secret',
  };

  function harness(revokeStatus: number) {
    const revocations: Array<Record<string, string>> = [];
    const routes: FixtureRoute[] = [
      {
        method: 'POST',
        url: 'https://auth.acme.example.com/oauth/token',
        handle: () => ({ status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } }),
      },
      { url: 'https://api.acme.example.com/me', handle: () => ({ status: 200, body: { name: 'acme user' } }) },
      {
        method: 'POST',
        url: REVOKE,
        handle: (_url, init) => {
          revocations.push(Object.fromEntries(new URLSearchParams(String(init.body))));
          return { status: revokeStatus, body: revokeStatus === 200 ? {} : { error: 'temporarily_unavailable' } };
        },
      },
    ];
    const h = buildHarness({ routes, env });
    return { h, revocations };
  }

  async function connectAcme(h: ReturnType<typeof harness>['h'], revocationUrl: string | null = REVOKE) {
    await h.catalog.createCustom(ORG, 'u-admin', {
      key: 'acme-oauth',
      kind: 'inference',
      displayName: 'Acme',
      connect: [
        {
          type: 'oauth2_code',
          credentialType: 'oauth2',
          oauth: {
            authorizeUrl: 'https://auth.acme.example.com/oauth/authorize',
            tokenUrl: 'https://auth.acme.example.com/oauth/token',
            clientId: 'platform',
            ...(revocationUrl ? { revocationUrl } : {}),
          },
        },
      ],
      validation: { kind: 'http', url: 'https://api.acme.example.com/me', secretField: 'accessToken' },
    } as any);
    const start = await h.service.connect(admin, ORG, 'acme-oauth', {});
    if (!start.pending || !('state' in start)) throw new Error('expected a redirect');
    return h.service.complete(start.state, 'code-1');
  }

  it('disconnect revokes the refresh token, then the access token (RFC 7009), then deletes the row', async () => {
    const { h, revocations } = harness(200);
    const connection = await connectAcme(h);

    expect(await h.service.disconnect(admin, ORG, connection.id)).toEqual({ revoked: true, revokeError: undefined });

    expect(revocations).toEqual([
      { token: 'rt-1', token_type_hint: 'refresh_token', client_id: 'acme-client', client_secret: 'acme-client-secret' },
      { token: 'at-1', token_type_hint: 'access_token', client_id: 'acme-client', client_secret: 'acme-client-secret' },
    ]);
    expect(h.credentials.rows).toHaveLength(0);
  });

  it('deletes the row anyway when the provider refuses, and reports why', async () => {
    const { h, revocations } = harness(503);
    const connection = await connectAcme(h);

    const outcome = await h.service.disconnect(admin, ORG, connection.id);

    expect(outcome.revoked).toBe(false);
    expect(outcome.revokeError).toContain('HTTP 503');
    expect(revocations).toHaveLength(2);
    expect(h.credentials.rows).toHaveLength(0);
  });

  it('answers "not attempted" for a connector with no way to revoke, and sends nothing', async () => {
    const { h, revocations } = harness(200);
    await connectAcme(h, null);
    const row = h.credentials.rows[0];

    await expect(h.service.revokeAtProvider(row)).resolves.toEqual({ attempted: false, revoked: false });
    expect(revocations).toEqual([]);
  });

  it('revokes from a wiped row\'s previous config, as offboarding hands it over', async () => {
    const { h, revocations } = harness(200);
    await connectAcme(h);
    const row = h.credentials.rows[0];
    // What wipeMemberConnections returns: the row with its config emptied,
    // and the secrets as they were beside it.
    const outcome = await h.service.revokeAtProvider({ ...row, config: { ...row.config } } as any);

    expect(outcome).toEqual({ attempted: true, revoked: true, via: 'oauth2', error: undefined });
    expect(revocations.map((r) => r.token)).toEqual(['rt-1', 'at-1']);
  });
});
