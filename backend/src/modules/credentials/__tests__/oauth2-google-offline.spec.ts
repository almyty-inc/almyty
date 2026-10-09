/**
 * Signing in to a Google API (Calendar, Gmail, Tasks) must leave a
 * credential that renews itself. Google only returns a refresh token when
 * the sign-in asks for offline access on a fresh consent screen; without
 * it the agent's calls start failing an hour after the sign-in.
 */
import { OAuth2Service } from '../oauth2.service';
import { Credential } from '../../../entities/credential.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { FakeRedis } from '../../../test/fake-redis';

describe('Google sign-in asks for a refresh token', () => {
  let service: OAuth2Service;

  beforeEach(() => {
    const credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
    const envelope = { encryptForOrg: jest.fn(async (_org: string, v: string) => `encrypted:${v}`) };
    service = new OAuth2Service(credentials as any, new FakeRedis() as any, envelope as any);
  });

  const start = (authorizationUrl: string, tokenUrl: string) =>
    service.generateAuthorizationUrl({
      organizationId: 'org-a',
      userId: 'user-a',
      apiId: 'calendar',
      clientId: 'client',
      clientSecret: 'secret',
      authorizationUrl,
      tokenUrl,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

  it('asks Google for offline access on a consent screen', async () => {
    // The URL Google's published Calendar description declares.
    const { authorizationUrl } = await start('https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/token');
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('keeps what the description already says', async () => {
    const { authorizationUrl } = await start('https://accounts.google.com/o/oauth2/auth?prompt=select_account', 'https://oauth2.googleapis.com/token');
    expect(new URL(authorizationUrl).searchParams.get('prompt')).toBe('select_account');
  });


  it('sends the provider back to the address the sign-in form tells people to register', async () => {
    // A Google OAuth client refuses a sign-in whose redirect it does not
    // list ("redirect_uri_mismatch"); the form shows callbackUrl() for that.
    const { authorizationUrl } = await start('https://accounts.google.com/o/oauth2/auth', 'https://oauth2.googleapis.com/token');
    expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(service.callbackUrl());
    expect(service.callbackUrl()).toMatch(/\/credentials\/oauth2\/callback$/);
  });
  it('adds nothing for other providers', async () => {
    const { authorizationUrl } = await start('https://auth.example.com/authorize', 'https://auth.example.com/token');
    const url = new URL(authorizationUrl);
    expect(url.searchParams.has('access_type')).toBe(false);
    expect(url.searchParams.has('prompt')).toBe(false);
  });
});
