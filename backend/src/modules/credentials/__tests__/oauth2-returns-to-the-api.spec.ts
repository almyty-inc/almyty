/**
 * Signing in to an API from its Key card: the OAuth2 flow brings the
 * browser back to the API's page, not to /credentials, and the token it
 * gets is the API's key (a Credential bound to the API). The return path
 * rides in the single-use state and is only ever a path in the app: a full
 * or protocol-relative URL would turn the callback into an open redirect.
 */
import { OAuth2Service, safeReturnPath } from '../oauth2.service';
import { OAuth2Controller } from '../oauth2.controller';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { FakeRedis } from '../../../test/fake-redis';
import { restoreEnv } from '../../../test/env';

describe('OAuth2 sign-in returns to where it started', () => {
  const originalFetch = global.fetch;
  const originalFrontend = process.env.FRONTEND_URL;
  let credentials: ReturnType<typeof fakeRepository<Credential>>;
  let service: OAuth2Service;

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
    const envelope = { encryptForOrg: jest.fn(async (_org: string, v: string) => `encrypted:${v}`) };
    service = new OAuth2Service(credentials as any, new FakeRedis() as any, envelope as any);
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreEnv('FRONTEND_URL', originalFrontend);
  });

  const start = (returnTo?: string) =>
    service.generateAuthorizationUrl({
      organizationId: 'org-a',
      userId: 'user-a',
      apiId: 'pets',
      clientId: 'client',
      clientSecret: 'secret',
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      returnTo,
    });

  async function callback(state: string) {
    const controller = new OAuth2Controller(service);
    const res = { redirect: jest.fn() };
    await controller.callback('code', state, res as any);
    return res.redirect.mock.calls[0][0] as string;
  }

  it('lands back on the API page with the token stored as the API\'s credential', async () => {
    const { state } = await start('/apis/pets');

    const to = await callback(state);

    const [row] = credentials.rows();
    expect(to).toBe(`https://app.example.com/apis/pets?oauth=success&credentialId=${row.id}`);
    expect(row).toMatchObject({ apiId: 'pets', organizationId: 'org-a', type: CredentialType.OAUTH2 });
  });

  it('keeps an existing query string', async () => {
    const { state } = await start('/apis/pets/setup?job=7');
    expect(await callback(state)).toMatch(/^https:\/\/app\.example\.com\/apis\/pets\/setup\?job=7&oauth=success&credentialId=/);
  });

  it.each(['https://evil.example.com/', '//evil.example.com/x', '/\\evil.example.com', 'apis/pets', '/apis/<script>'])(
    'never redirects off the app (%s)',
    async (returnTo) => {
      expect(safeReturnPath(returnTo)).toBeNull();
      const { state } = await start(returnTo);
      expect(await callback(state)).toMatch(/^https:\/\/app\.example\.com\/credentials\?oauth=success/);
    },
  );
});
