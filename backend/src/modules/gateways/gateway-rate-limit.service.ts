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
