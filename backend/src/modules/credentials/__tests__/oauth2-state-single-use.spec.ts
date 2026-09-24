/**
 * The OAuth2 `state` is single-use: of any number of callbacks that carry
 * the same state, exactly one may exchange the code and create a
 * credential.
 *
 * The Redis double below behaves like a real one across a network: each
 * command takes effect on the server when it is sent and its reply comes
 * back a round trip later. Under that model a GET followed by a DEL lets
 * two concurrent callbacks both read the state before either deletes it;
 * GETDEL cannot. A double whose `get` and `del` ran back to back with no
 * round trip between them would hide exactly that window.
 */
import { UnauthorizedException } from '@nestjs/common';
import { OAuth2Service } from '../oauth2.service';
import { Credential } from '../../../entities/credential.entity';
import { fakeRepository } from '../../../test/fake-repository';

const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      await roundTrip();
      return 'OK';
    }),
    get: jest.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      await roundTrip();
      return value;
    }),
    del: jest.fn(async (key: string) => {
      const existed = store.delete(key);
      await roundTrip();
      return existed ? 1 : 0;
    }),
    getdel: jest.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      await roundTrip();
      return value;
    }),
  };
}

describe('OAuth2Service.handleCallback consumes state once', () => {
  const originalFetch = global.fetch;
  let redis: ReturnType<typeof fakeRedis>;
  let credentials: ReturnType<typeof fakeRepository<Credential>>;
  let service: OAuth2Service;
  let state: string;

  beforeEach(async () => {
    redis = fakeRedis();
    credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
    const envelope = { encryptForOrg: jest.fn(async (_org: string, v: string) => `encrypted:${v}`) };
    service = new OAuth2Service(credentials as any, redis as any, envelope as any);

    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as any;

    ({ state } = await service.generateAuthorizationUrl({
      organizationId: 'org-a',
      userId: 'user-a',
      clientId: 'client',
      clientSecret: 'secret',
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('lets exactly one of two concurrent callbacks with the same state through', async () => {
    const results = await Promise.allSettled([
      service.handleCallback('code', state),
      service.handleCallback('code', state),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(UnauthorizedException);

    // One authorization, one token exchange, one credential.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(credentials.rows()).toHaveLength(1);
    expect(redis.store.size).toBe(0);
  });

  it('refuses a callback replayed after the first completed', async () => {
    await service.handleCallback('code', state);
    await expect(service.handleCallback('code', state)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(credentials.rows()).toHaveLength(1);
  });

  it('refuses an unknown state without exchanging anything', async () => {
    await expect(service.handleCallback('code', 'not-a-state')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(credentials.rows()).toHaveLength(0);
  });
});
