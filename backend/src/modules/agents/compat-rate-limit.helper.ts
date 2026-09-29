import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import type * as Redis from 'ioredis';

/** Requests allowed per key per fixed one-minute window. */
export const COMPAT_RATE_LIMIT_RPM = 60;

/** Cap on the in-memory request-count map. Prevents unbounded growth from key churn. */
export const COMPAT_MAX_TRACKED_KEYS = 10_000;

export interface CompatRateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: number;
  /**
   * This request is over the limit and must be refused. Not the same as
   * `remaining === 0`: the request that spends the last slot is allowed
   * and leaves 0 remaining. Refusing on `remaining <= 0` served 59 of a
   * 60-request window.
   */
  limited: boolean;
}

/** The window as seen by the `count`-th request in it. */
function windowInfo(count: number, resetAt: number): CompatRateLimitInfo {
  return {
    remaining: Math.max(0, COMPAT_RATE_LIMIT_RPM - count),
    limit: COMPAT_RATE_LIMIT_RPM,
    resetAt,
    limited: count > COMPAT_RATE_LIMIT_RPM,
  };
}

/**
 * Per-key fixed-window rate limit for the OpenAI- and Anthropic-compatible
 * routes.
 *
 * This lived as a set of private methods on the OpenAI controller, which meant
 * /v1/messages had no per-key counter at all: only the global 100/60s
 * ThrottlerGuard default stood between a valid key and unbounded agent runs on
 * the org's account. Both routes authenticate the same api-keys and spend the
 * same budget, so they share one limiter rather than one of them having a
 * better one.
 *
 * Redis (atomic INCR + EXPIRE) gives a window shared across replicas; a
 * per-pod in-memory counter is the fallback when Redis is absent or
 * unreachable, so a transient Redis blip degrades to local limiting rather
 * than removing the limit or failing the request.
 */
export class CompatRateLimiter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly keyPrefix: string,
    private readonly logger: Logger,
    private readonly redis?: Redis.Redis,
  ) {}

  async track(apiKeyId: string): Promise<CompatRateLimitInfo> {
    if (!this.redis) {
      return this.trackInMemory(apiKeyId);
    }
    const windowMs = 60_000;
    const now = Date.now();
    const windowId = Math.floor(now / windowMs);
    const resetAt = (windowId + 1) * windowMs;
    try {
      const key = `${this.keyPrefix}:${apiKeyId}:${windowId}`;
      const count = await this.redis.incr(key);
      // Set the TTL once, on the first increment of the window. A slightly
      // longer TTL than the window absorbs clock skew without leaking keys.
      if (count === 1) {
        await this.redis.expire(key, 70);
      }
      return windowInfo(count, resetAt);
    } catch (err: any) {
      this.logger.warn(
        `Rate-limit Redis unavailable, falling back to per-pod counter: ${err?.message}`,
      );
      return this.trackInMemory(apiKeyId);
    }
  }

  /**
   * The X-RateLimit-* headers on every response, and on a refusal the
   * standard Retry-After. Both SDKs wait for Retry-After before their
   * automatic retry; without it they back off blind, a second or two, and
   * spend their retries inside the same closed window.
   */
  setHeaders(res: Response, info: CompatRateLimitInfo): void {
    res.setHeader('X-RateLimit-Limit', String(info.limit));
    res.setHeader('X-RateLimit-Remaining', String(info.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(info.resetAt / 1000)));
    if (info.limited) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((info.resetAt - Date.now()) / 1000))));
    }
  }

  /** Exposed for tests that assert the map stays bounded. */
  get trackedKeyCount(): number {
    return this.counts.size;
  }

  private trackInMemory(apiKeyId: string): CompatRateLimitInfo {
    const now = Date.now();
    const existing = this.counts.get(apiKeyId);

    if (!existing || now >= existing.resetAt) {
      this.evictIfFull(now);
      const resetAt = now + 60_000;
      this.counts.set(apiKeyId, { count: 1, resetAt });
      return windowInfo(1, resetAt);
    }

    existing.count++;
    return windowInfo(existing.count, existing.resetAt);
  }

  /**
   * Bound the request-count map. Without this it grows one entry per unique
   * api-key id seen, with no eviction -- a slow memory leak that is bad in any
   * deployment that rotates keys, and easy to weaponise on a public endpoint.
   *
   * Drop expired entries first; if still at capacity, drop the oldest
   * insertion (Map iteration order is insertion order in JS).
   */
  private evictIfFull(now: number): void {
    if (this.counts.size < COMPAT_MAX_TRACKED_KEYS) return;

    for (const [k, v] of this.counts) {
      if (now >= v.resetAt) this.counts.delete(k);
    }
    if (this.counts.size < COMPAT_MAX_TRACKED_KEYS) return;

    const oldest = this.counts.keys().next().value;
    if (oldest !== undefined) this.counts.delete(oldest);
  }
}
