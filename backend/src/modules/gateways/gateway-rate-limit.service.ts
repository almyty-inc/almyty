/**
 * Enforces a gateway's own rateLimitConfig on protocol traffic.
 *
 * The platform-wide ThrottlerGuard protects the API as a whole; this
 * service applies the per-gateway limits users configure in the
 * dashboard (requestsPerMinute / Hour / Day), which were previously
 * stored but never read on the request path. Counters live in Redis
 * (fixed windows, one atomic INCR+EXPIRE script) so limits hold across
 * replicas, and the check fails open on Redis outage — same trade-off
 * as the per-tool limiter in tool-cache-rate-limit.helper.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

import { Gateway } from '../../entities/gateway.entity';

export interface GatewayRateLimitResult {
  limited: boolean;
  message?: string;
  retryAfterSeconds?: number;
  /** Stable code the page can branch on: surface ceiling vs. this visitor. */
  code?: 'SURFACE_RATE_LIMITED' | 'VISITOR_RATE_LIMITED' | 'RATE_LIMIT_UNAVAILABLE';
  /**
   * Which bucket tripped: its window label, the ceiling, and the scope
   * it was counted against. The code says which *kind* of limit; this
   * says which one, so a "we're being throttled" ticket can be answered
   * without re-deriving the config by hand.
   */
  bucket?: {
    window: string;
    limit: number;
    scope: 'surface' | 'user' | 'ip';
  };

}

/**
 * Burst allowance per minute for an hourly ceiling: a fifth of the hour
 * (never below 3), so short exchanges feel natural but an hour's budget
 * cannot go in one burst.
 */
export function burstPerMinute(perHour: number): number {
  return Math.max(3, Math.ceil(perHour / 5));
}

/**
 * The per-address ceiling a public surface gets when its tenant has
 * configured none.
 *
 * "Unconfigured" used to mean "unlimited": `rateLimitConfig` is a
 * nullable column with no default, `check()` returns early when
 * `enabled` is falsy, and `checkVisitor` skipped every scope whose
 * limit was unset — so a chat_widget or hosted_chat gateway created
 * without touching the rate-limit form was an anonymous, unmetered way
 * to spend the tenant's model budget. The publish gate that was meant
 * to prevent that (`canPublishHostedChat`) never receives these values
 * and its two public-link refusals are filtered out by the only caller,
 * so nothing upstream required them either.
 *
 * This is a floor, not a policy. It applies only when the tenant set no
 * per-address limit at all, and any configured value — higher or lower
 * — wins over it. It is deliberately loose: it exists to bound a
 * runaway, not to shape normal use, and a shared NAT should not hit it
 * in ordinary conversation.
 */
export const DEFAULT_PUBLIC_PER_IP_PER_HOUR = 240;

const WINDOWS = [
  { field: 'requestsPerMinute', label: 'minute', seconds: 60 },
  { field: 'requestsPerHour', label: 'hour', seconds: 3600 },
  { field: 'requestsPerDay', label: 'day', seconds: 86400 },
] as const;

@Injectable()
export class GatewayRateLimitService {
  private readonly logger = new Logger(GatewayRateLimitService.name);

  constructor(@InjectRedis() private readonly redis: Redis.Redis) {}

  /**
   * Per-visitor and per-IP ceilings for a public surface.
   *
   * The surface-wide check above is a spend ceiling for the whole
   * product. This is the one that stops a single visitor (or one
   * address behind a NAT) from using up everyone's share: each visitor
   * and each address gets its own hour bucket, plus a burst bucket per
   * minute so an hour's allowance cannot be spent in ten seconds.
   *
   * The address scope always applies when the caller supplies a
   * `clientHash`, falling back to DEFAULT_PUBLIC_PER_IP_PER_HOUR when
   * the tenant configured nothing. Before that, an unconfigured gateway
   * produced no scopes at all and this returned `{limited: false}` —
   * which is to say the anonymous surfaces had no ceiling whatsoever
   * until someone remembered to fill in a form.
   *
   * The visitor scope stays opt-in: its id comes from a session the
   * caller can discard (hosted chat) or a field the caller invents
   * (the widget), so it narrows an honest browser and is not relied on.
   */
  async checkVisitor(
    gateway: Gateway,
    who: { endUserId?: string | null; clientHash?: string | null },
  ): Promise<GatewayRateLimitResult> {
    const config = gateway.rateLimitConfig;
    const scopes: Array<{ scope: string; id: string; perHour: number; what: string }> = [];
    if (config?.perVisitorPerHour && config.perVisitorPerHour > 0 && who.endUserId) {
      scopes.push({ scope: 'user', id: who.endUserId, perHour: config.perVisitorPerHour, what: 'you' });
    }
    if (who.clientHash) {
      const perIp =
        config?.perIpPerHour && config.perIpPerHour > 0
          ? config.perIpPerHour
          : DEFAULT_PUBLIC_PER_IP_PER_HOUR;
      scopes.push({ scope: 'ip', id: who.clientHash, perHour: perIp, what: 'your network' });
    }
    if (scopes.length === 0) return { limited: false };

    try {
      for (const { scope, id, perHour, what } of scopes) {
        const windows = [
          { label: 'hour', seconds: 3600, limit: perHour },
          { label: 'minute', seconds: 60, limit: burstPerMinute(perHour) },
        ];
        for (const window of windows) {
          const bucket = Math.floor(Date.now() / (window.seconds * 1000));
          const key = `gw_rate:${gateway.id}:${scope}:${id}:${window.label}:${bucket}`;
          const count = await this.bumpWindow(key, window.seconds);
          if (count > window.limit) {
            const windowEnd = (bucket + 1) * window.seconds * 1000;
            const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - Date.now()) / 1000));
            return {
              limited: true,
              code: 'VISITOR_RATE_LIMITED',
              message:
                `Too many messages from ${what} (${window.limit} per ${window.label}). ` +
                `Please wait ${retryAfterSeconds} seconds.`,
              retryAfterSeconds,
              bucket: { window: window.label, limit: window.limit, scope: scope as 'user' | 'ip' },
            };
          }
        }
      }
      return { limited: false };
    } catch (error: any) {
      this.logger.warn(`Visitor rate limit check failed, allowing request: ${error.message}`);
      return { limited: false };
    }
  }

  async check(gateway: Gateway): Promise<GatewayRateLimitResult> {
    const config = gateway.rateLimitConfig;
    if (!config?.enabled) return { limited: false };

    try {
      for (const window of WINDOWS) {
        const limit = config[window.field];
        if (!limit || limit <= 0) continue;

        const bucket = Math.floor(Date.now() / (window.seconds * 1000));
        const key = `gw_rate:${gateway.id}:${window.label}:${bucket}`;
        const count = await this.bumpWindow(key, window.seconds);
        if (count > limit) {
          const windowEnd = (bucket + 1) * window.seconds * 1000;
          return {
            limited: true,
            code: 'SURFACE_RATE_LIMITED',
            message: `Gateway rate limit exceeded: ${limit} requests per ${window.label}`,
            retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - Date.now()) / 1000)),
            bucket: { window: window.label, limit, scope: 'surface' },
          };
        }
      }
      return { limited: false };
    } catch (error: any) {
      // Fail open — a limiter dependency failure should not take the
      // gateway down.
      this.logger.warn(`Gateway rate limit check failed, allowing request: ${error.message}`);
      return { limited: false };
    }
  }

  /**
   * Fixed-window ceilings for one sensitive action, such as sending a
   * sign-in code. Each bucket is its own counter (per visitor, per
   * address, per recipient -- never one bucket for the whole surface, or
   * one visitor could lock everybody else out).
   *
   * Unlike the message limits above this fails CLOSED: a code that is
   * sent while the counter cannot be read is a code nobody counted, and
   * the limits here are what stand between an address and a mail bomb,
   * or a code and a brute force.
   */
  async checkAction(
    buckets: Array<{ key: string; limit: number; seconds: number; what: string }>,
  ): Promise<GatewayRateLimitResult> {
    try {
      for (const { key, limit, seconds, what } of buckets) {
        const bucket = Math.floor(Date.now() / (seconds * 1000));
        const count = await this.bumpWindow(`gw_action:${key}:${bucket}`, seconds);
        if (count > limit) {
          const windowEnd = (bucket + 1) * seconds * 1000;
          const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - Date.now()) / 1000));
          return {
            limited: true,
            code: 'VISITOR_RATE_LIMITED',
            message: `Too many attempts from ${what}. Please wait ${retryAfterSeconds} seconds.`,
            retryAfterSeconds,
          };
        }
      }
      return { limited: false };
    } catch (error: any) {
      this.logger.warn(`Action rate limit check failed, refusing: ${error.message}`);
      return {
        limited: true,
        code: 'RATE_LIMIT_UNAVAILABLE',
        message: 'This is unavailable for a moment. Please try again shortly.',
        retryAfterSeconds: 30,
      };
    }
  }

  /**
   * Bump one fixed window's counter and make sure it expires.
   *
   * This was `INCR` followed by `EXPIRE` only when the count came back
   * 1 — two round trips, so a process that died between them left the
   * key with no TTL, and Redis then kept it for good instead of
   * reclaiming it when its window passed. One script does both
   * atomically, and re-arms the TTL on any key found without one, so a
   * counter already stranded that way heals on its next request.
   */
  private async bumpWindow(key: string, seconds: number): Promise<number> {
    const count = await this.redis.eval(BUMP_WINDOW_SCRIPT, 1, key, String(seconds));
    return Number(count);
  }
}

/** INCR a window counter and arm its TTL, in one atomic step. */
export const BUMP_WINDOW_SCRIPT = `local n = redis.call('incr', KEYS[1])
       if redis.call('ttl', KEYS[1]) < 0 then
         redis.call('expire', KEYS[1], ARGV[1])
       end
       return n`;