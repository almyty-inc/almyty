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

  it('the Redis store uses GETDEL with the TTL, falling back to GET+DEL', async () => {
    const redis = { set: jest.fn(async () => 'OK'), getdel: jest.fn(async () => JSON.stringify(payload())), get: jest.fn(), del: jest.fn() };
    const store = new RedisConnectStateStore(redis as any);
    await store.put('s1', payload(), 600);
    expect(redis.set).toHaveBeenCalledWith('connections:state:s1', expect.any(String), 'EX', 600);
    expect(await store.take('s1')).toMatchObject({ connectorKey: 'openrouter' });
    expect(redis.getdel).toHaveBeenCalledWith('connections:state:s1');

    const legacy = { set: jest.fn(), get: jest.fn(async () => JSON.stringify(payload())), del: jest.fn(async () => 1) };
    const fallback = new RedisConnectStateStore(legacy as any);
    expect(await fallback.take('s2')).toMatchObject({ connectorKey: 'openrouter' });
    expect(legacy.del).toHaveBeenCalledWith('connections:state:s2');
    legacy.get.mockResolvedValueOnce(null as any);
    expect(await fallback.take('s3')).toBeNull();
  });
});
