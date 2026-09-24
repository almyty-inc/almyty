import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { ConfigService } from '@nestjs/config';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

import { throttlerTracker } from './throttler-tracker';

/**
 * Options for the global `ThrottlerGuard`.
 *
 * This lives outside app.module.ts so the wiring can be tested: an
 * inline `useFactory` is unreachable from a spec, and a tracker nothing
 * ever calls is the same bug with better comments. `app.module.spec.ts`
 * boots a real guard on these options.
 */
export function buildThrottlerOptions(
  configService: ConfigService,
): ThrottlerModuleOptions {
  const host = configService.get('REDIS_HOST');
  // @nestjs/throttler v5+ takes ttl in MILLISECONDS. RATE_LIMIT_TTL
  // stays in seconds (that's what the deploy configs set), so convert
  // here. Passing seconds straight through made the window 60ms —
  // 100 requests per 60ms — i.e. the global rate limit never fired.
  const ttlSeconds = Number(configService.get('RATE_LIMIT_TTL', 60));
  const config: any = {
    // WITHOUT this the library defaults to `normalizeIp(req.ip)`, and
    // since Express `trust proxy` is off here (deliberately — see
    // common/security/client-ip.ts) `req.ip` behind the ingress is the
    // proxy's address on every request. That is a single bucket for the
    // entire platform: 100 requests a minute shared by every user and
    // every tenant. See throttler-tracker.ts for the full reasoning.
    getTracker: (req: Record<string, any>) => throttlerTracker(req),
    throttlers: [
      {
        ttl: ttlSeconds * 1000,
        limit: Number(configService.get('RATE_LIMIT_MAX', 100)),
      },
    ],
  };
  if (host) {
    const port = configService.get('REDIS_PORT', 6379);
    config.storage = new ThrottlerStorageRedisService(`redis://${host}:${port}`);
  }
  return config;
}
