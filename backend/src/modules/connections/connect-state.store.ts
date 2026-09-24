import { Inject, Injectable, Optional } from '@nestjs/common';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';
import { randomBytes } from 'crypto';

/**
 * What a pending redirect connect remembers between the authorize
 * redirect and the callback. The PKCE verifier never leaves the server;
 * the state is the only thing the browser carries.
 */
export interface PendingConnect {
  organizationId: string;
  userId: string;
  ownerUserId: string | null;
  connectorKey: string;
  methodType: string;
  codeVerifier: string | null;
  callbackUrl: string | null;
  mode: 'browser' | 'headless';
  /** Set when the flow rotates an existing connection instead of creating one. */
  rotateConnectionId: string | null;
  /** Non-secret form values captured before the redirect. */
  input: Record<string, unknown>;
  createdAt: number;
}

export interface ConnectStateStore {
  put(state: string, payload: PendingConnect, ttlSeconds: number): Promise<void>;
  /** Returns and deletes the payload: a state is single use. */
  take(state: string): Promise<PendingConnect | null>;
}

export const CONNECT_STATE_TTL_SECONDS = 600;

export function newState(): string {
  return randomBytes(32).toString('base64url');
}

/** In-memory store with TTL; the fallback when no Redis client is bound, and what tests use. */
export class MemoryConnectStateStore implements ConnectStateStore {
  private readonly entries = new Map<string, { payload: PendingConnect; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async put(state: string, payload: PendingConnect, ttlSeconds: number): Promise<void> {
    this.sweep();
    this.entries.set(state, { payload, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async take(state: string): Promise<PendingConnect | null> {
    const entry = this.entries.get(state);
    if (!entry) return null;
    this.entries.delete(state);
    if (entry.expiresAt <= this.now()) return null;
    return entry.payload;
  }

  size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= t) this.entries.delete(k);
  }
}

/**
 * The two commands the store needs. GETDEL (Redis >= 6.2) is required, not
 * optional: a GET followed by a DEL lets two callbacks carrying the same
 * state both read it before either deletes it, so there is no fallback.
 */
interface RedisLike {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/** Redis-backed store so a callback can land on any API replica. */
export class RedisConnectStateStore implements ConnectStateStore {
  private static readonly PREFIX = 'connections:state:';

  constructor(private readonly redis: RedisLike) {}

  async put(state: string, payload: PendingConnect, ttlSeconds: number): Promise<void> {
    await this.redis.set(RedisConnectStateStore.PREFIX + state, JSON.stringify(payload), 'EX', ttlSeconds);
  }

  async take(state: string): Promise<PendingConnect | null> {
    const raw = await this.redis.getdel(RedisConnectStateStore.PREFIX + state);
    return raw ? (JSON.parse(raw) as PendingConnect) : null;
  }
}

export const CONNECT_STATE_STORE = Symbol('CONNECT_STATE_STORE');

/**
 * Picks Redis when the app has a client bound (multi-replica safe),
 * else memory. Injectable so specs pass their own store.
 */
@Injectable()
export class ConnectStateStoreFactory {
  constructor(@Optional() @Inject(getRedisConnectionToken()) private readonly redis?: RedisLike) {}

  create(): ConnectStateStore {
    return this.redis ? new RedisConnectStateStore(this.redis) : new MemoryConnectStateStore();
  }
}
