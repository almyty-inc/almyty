import { createHash } from 'crypto';

import { generatePkcePair, pkceChallengeFor, verifyPkceChallenge } from '../../credentials/oauth2.service';
import { CONNECT_STATE_TTL_SECONDS, MemoryConnectStateStore, PendingConnect, RedisConnectStateStore, newState } from '../connect-state.store';

const payload = (over: Partial<PendingConnect> = {}): PendingConnect => ({
  organizationId: 'org-1', userId: 'u-1', ownerUserId: null, connectorKey: 'openrouter', methodType: 'oauth2_pkce',
  codeVerifier: 'v', callbackUrl: null, mode: 'browser', rotateConnectionId: null, input: {}, createdAt: 0, ...over,
});

describe('PKCE S256', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    expect(pkceChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates a 43-char base64url verifier whose challenge is its SHA-256', () => {
    const pair = generatePkcePair();
    expect(pair.codeChallengeMethod).toBe('S256');
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).toBe(createHash('sha256').update(pair.codeVerifier).digest('base64url'));
    expect(verifyPkceChallenge(pair.codeVerifier, pair.codeChallenge)).toBe(true);
    expect(verifyPkceChallenge(pair.codeVerifier + 'x', pair.codeChallenge)).toBe(false);
    expect(verifyPkceChallenge(pair.codeVerifier, 'short')).toBe(false);
    expect(generatePkcePair().codeVerifier).not.toBe(pair.codeVerifier);
  });
});

describe('connect state store', () => {
  it('states are 256-bit, single use and expire after ten minutes', async () => {
    let now = 1_000_000;
    const store = new MemoryConnectStateStore(() => now);
    const state = newState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(CONNECT_STATE_TTL_SECONDS).toBe(600);

    await store.put(state, payload(), CONNECT_STATE_TTL_SECONDS);
    now += 599_000;
    expect(await store.take(state)).toMatchObject({ connectorKey: 'openrouter', codeVerifier: 'v' });
    expect(await store.take(state)).toBeNull();

    const late = newState();
    await store.put(late, payload(), CONNECT_STATE_TTL_SECONDS);
    now += 600_000;
    expect(await store.take(late)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('the Redis store writes with the TTL and consumes with GETDEL', async () => {
    const redis = fakeRedis();
    const store = new RedisConnectStateStore(redis);
    await store.put('s1', payload(), 600);
    expect(redis.set).toHaveBeenCalledWith('connections:state:s1', expect.any(String), 'EX', 600);
    expect(await store.take('s1')).toMatchObject({ connectorKey: 'openrouter' });
    expect(redis.getdel).toHaveBeenCalledWith('connections:state:s1');
    expect(await store.take('s1')).toBeNull();
    expect(await store.take('never-issued')).toBeNull();
  });
});

/**
 * A connect state is single use: of any number of callbacks carrying the
 * same state, exactly one gets the pending connect (and with it the PKCE
 * verifier).
 *
 * The double behaves like Redis across a network: a command takes effect
 * on the server when sent and its reply arrives a round trip later. It
 * offers only SET and an atomic GETDEL -- no GET or DEL the store could
 * fall back to, since GET-then-DEL lets concurrent callbacks both read the
 * state inside the round trip between them.
 */
const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    set: jest.fn(async (key: string, value: string, _mode: 'EX', _ttl: number) => {
      data.set(key, value);
      await roundTrip();
      return 'OK';
    }),
    getdel: jest.fn(async (key: string) => {
      const value = data.get(key) ?? null;
      data.delete(key);
      await roundTrip();
      return value;
    }),
  };
}

describe('connect state is consumed once under concurrency', () => {
  const N = 8;

  it('Redis store: exactly one of N parallel takes of one state wins', async () => {
    const redis = fakeRedis();
    const store = new RedisConnectStateStore(redis);
    const state = newState();
    await store.put(state, payload(), CONNECT_STATE_TTL_SECONDS);

    const taken = await Promise.all(Array.from({ length: N }, () => store.take(state)));

    expect(taken.filter((p) => p !== null)).toHaveLength(1);
    expect(taken.find((p) => p !== null)).toMatchObject({ codeVerifier: 'v' });
    expect(redis.data.size).toBe(0);
  });

  it('memory store: exactly one of N parallel takes of one state wins', async () => {
    const store = new MemoryConnectStateStore();
    const state = newState();
    await store.put(state, payload(), CONNECT_STATE_TTL_SECONDS);

    const taken = await Promise.all(Array.from({ length: N }, () => store.take(state)));

    expect(taken.filter((p) => p !== null)).toHaveLength(1);
    expect(store.size()).toBe(0);
  });
});
