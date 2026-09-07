/**
 * Enforces a gateway's own rateLimitConfig on protocol traffic.
 *
 * The platform-wide ThrottlerGuard protects the API as a whole; this
 * service applies the per-gateway limits users configure in the
 * dashboard (requestsPerMinute / Hour / Day), which were previously
 * stored but never read on the request path. Counters live in Redis
 * (fixed windows, INCR + EXPIRE) so limits hold across replicas, and
 * the check fails open on Redis outage — same trade-off as the
 * per-tool limiter in tool-cache-rate-limit.helper.
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
  code?: 'SURFACE_RATE_LIMITED' | 'VISITOR_RATE_LIMITED';

}

/**
 * Burst allowance per minute for an hourly ceiling: a fifth of the hour
 * (never below 3), so short exchanges feel natural but an hour's budget
 * cannot go in one burst.
 */
export function burstPerMinute(perHour: number): number {
  return Math.max(3, Math.ceil(perHour / 5));
}

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
    if (config?.perIpPerHour && config.perIpPerHour > 0 && who.clientHash) {
      scopes.push({ scope: 'ip', id: who.clientHash, perHour: config.perIpPerHour, what: 'your network' });
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
          const count = await this.redis.incr(key);
          if (count === 1) await this.redis.expire(key, window.seconds);
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
        const count = await this.redis.incr(key);
        if (count === 1) {
          await this.redis.expire(key, window.seconds);
        }
        if (count > limit) {
          const windowEnd = (bucket + 1) * window.seconds * 1000;
          return {
            limited: true,
            code: 'SURFACE_RATE_LIMITED',
            message: `Gateway rate limit exceeded: ${limit} requests per ${window.label}`,

            retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - Date.now()) / 1000)),
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
}
