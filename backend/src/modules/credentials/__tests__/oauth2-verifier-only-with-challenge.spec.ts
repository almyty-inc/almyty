/**
 * The token exchange sends a PKCE code_verifier only when the sign-in sent
 * a code challenge. Google refuses an exchange that carries a verifier the
 * authorization request never announced ("code_verifier or verifier is not
 * needed"), which broke every Google sign-in started from an API's page:
 * those use the URLs from the API's description, not a preset, so they
 * send no challenge.
 */
import { OAuth2Service } from '../oauth2.service';
import { Credential } from '../../../entities/credential.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { FakeRedis } from '../../../test/fake-redis';

describe('OAuth2 token exchange and PKCE', () => {
  const originalFetch = global.fetch;
  let service: OAuth2Service;
  let credentials: ReturnType<typeof fakeRepository<Credential>>;
  let sent: URLSearchParams[];

  beforeEach(() => {
    credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
    const envelope = { encryptForOrg: jest.fn(async (_org: string, v: string) => `encrypted:${v}`) };
    service = new OAuth2Service(credentials as any, new FakeRedis() as any, envelope as any);
    sent = [];
    global.fetch = jest.fn(async (_url: any, init: any) => {
      const body = new URLSearchParams(String(init.body));
      sent.push(body);
      // Google's answer to a verifier it did not ask for.
      if (body.has('code_verifier') && !body.get('code_verifier_expected')) {
        return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'code_verifier or verifier is not needed.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('signs in to Google from an API page (no preset, no challenge) without a verifier', async () => {
    const { authorizationUrl, state } = await service.generateAuthorizationUrl({
      organizationId: 'org-a',
      userId: 'user-a',
      apiId: 'calendar',
      clientId: 'client',
      clientSecret: 'secret',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    expect(new URL(authorizationUrl).searchParams.has('code_challenge')).toBe(false);

    const result = await service.handleCallback('code', state);

    expect(result.credentialId).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0].has('code_verifier')).toBe(false);
    expect(credentials.rows()).toHaveLength(1);
  });

  it('sends the verifier that matches the challenge when the preset uses PKCE', async () => {
    const { authorizationUrl, state } = await service.generateAuthorizationUrl({
      organizationId: 'org-a',
      userId: 'user-a',
      provider: 'google',
      clientId: 'client',
      clientSecret: 'secret',
    } as any);
    const challenge = new URL(authorizationUrl).searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();

    // A provider that asked for PKCE expects the verifier: answer success here.
    (global.fetch as jest.Mock).mockImplementationOnce(async (_url: any, init: any) => {
      sent.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await service.handleCallback('code', state);

    const verifier = sent[0].get('code_verifier');
    expect(verifier).toBeTruthy();
    const { createHash } = await import('crypto');
    expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(challenge);
  });
});
