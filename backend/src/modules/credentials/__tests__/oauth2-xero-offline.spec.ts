/**
 * Signing in to Xero must leave a credential that renews itself. Xero
 * returns a refresh token only for the offline_access scope, which its
 * published API description does not list; without it every call fails
 * 30 minutes after the sign-in.
 */
import { OAuth2Service } from '../oauth2.service';
import { Credential } from '../../../entities/credential.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { FakeRedis } from '../../../test/fake-redis';

describe('Xero sign-in asks for a refresh token', () => {
  let service: OAuth2Service;

  beforeEach(() => {
    const credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
    const envelope = { encryptForOrg: jest.fn(async (_org: string, v: string) => `encrypted:${v}`) };
    service = new OAuth2Service(credentials as any, new FakeRedis() as any, envelope as any);
  });

  const start = (authorizationUrl: string, scopes: string[]) =>
    service.generateAuthorizationUrl({
      organizationId: 'org-a',
      userId: 'user-a',
      apiId: 'xero',
      clientId: 'client',
      clientSecret: 'secret',
      authorizationUrl,
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes,
    });

  it('adds offline_access to the scopes ticked from the description', async () => {
    // The URL Xero's published Accounting API description declares.
    const { authorizationUrl } = await start('https://login.xero.com/identity/connect/authorize', ['accounting.transactions.read']);
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('accounting.transactions.read offline_access');
  });

  it('does not add it twice', async () => {
    const { authorizationUrl } = await start('https://login.xero.com/identity/connect/authorize', ['offline_access', 'accounting.transactions.read']);
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('offline_access accounting.transactions.read');
  });

  it('adds nothing for other providers', async () => {
    const { authorizationUrl } = await start('https://auth.example.com/authorize', ['read']);
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('read');
  });
});
