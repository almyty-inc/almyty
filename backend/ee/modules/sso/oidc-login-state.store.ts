import { Inject, Injectable, Optional } from '@nestjs/common';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';

/**
 * What an OIDC sign-in remembers between the authorize redirect and the
 * callback, keyed by its `state`. The PKCE verifier and the nonce never
 * leave the server: the browser carries only the state (in a cookie and
 * through the IdP), and a state is good for one callback.
 */
export interface PendingOidcLogin {
  organizationId: string;
  /** RFC 7636 code_verifier; its S256 challenge went to the IdP. */
  codeVerifier: string;
  /** Sent as `nonce`; the ID token must carry it back. */
  nonce: string;
  /** The redirect_uri the code was requested for; null means the org's configured one. */
  redirectUri: string | null;
  createdAt: number;
}

export interface OidcLoginStateStore {
  put(state: string, pending: PendingOidcLogin, ttlSeconds: number): Promise<void>;
  /** Returns and deletes the entry: a state is single use. */
  take(state: string): Promise<PendingOidcLogin | null>;
}

/** Matches the state cookie's lifetime (SSO_STATE_COOKIE_OPTIONS). */
export const OIDC_LOGIN_TTL_SECONDS = 600;

/** In-memory store with TTL: the fallback when no Redis client is bound, and what specs use. */
export class MemoryOidcLoginStateStore implements OidcLoginStateStore {
  private readonly entries = new Map<string, { pending: PendingOidcLogin; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async put(state: string, pending: PendingOidcLogin, ttlSeconds: number): Promise<void> {
    this.sweep();
    this.entries.set(state, { pending, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async take(state: string): Promise<PendingOidcLogin | null> {
    const entry = this.entries.get(state);
    if (!entry) return null;
    this.entries.delete(state);
    if (entry.expiresAt <= this.now()) return null;
    return entry.pending;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= t) this.entries.delete(k);
  }
}

/**
 * GETDEL (Redis >= 6.2) is required: a GET then DEL lets two callbacks
 * with the same state both read the verifier before either deletes it.
 */
interface RedisLike {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/** Redis-backed, so the callback can land on any API replica. */
export class RedisOidcLoginStateStore implements OidcLoginStateStore {
  private static readonly PREFIX = 'sso:oidc:state:';

  constructor(private readonly redis: RedisLike) {}

  async put(state: string, pending: PendingOidcLogin, ttlSeconds: number): Promise<void> {
    await this.redis.set(RedisOidcLoginStateStore.PREFIX + state, JSON.stringify(pending), 'EX', ttlSeconds);
  }

  async take(state: string): Promise<PendingOidcLogin | null> {
    const raw = await this.redis.getdel(RedisOidcLoginStateStore.PREFIX + state);
    return raw ? (JSON.parse(raw) as PendingOidcLogin) : null;
  }
}

/** Redis when the app has a client bound (multi-replica safe), else memory. */
@Injectable()
export class OidcLoginStateStoreFactory {
  constructor(@Optional() @Inject(getRedisConnectionToken()) private readonly redis?: RedisLike) {}

  create(): OidcLoginStateStore {
    return this.redis ? new RedisOidcLoginStateStore(this.redis) : new MemoryOidcLoginStateStore();
  }
}
