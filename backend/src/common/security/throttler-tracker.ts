/**
 * The bucket key the global `ThrottlerGuard` counts requests into.
 *
 * `@nestjs/throttler`'s default tracker is `normalizeIp(req.ip)`. Express
 * `trust proxy` is off in this app on purpose (see client-ip.ts and
 * referrals.constants.ts), so in every deployed environment `req.ip` is
 * the ingress pod's address for EVERY request — one bucket shared by the
 * whole platform. With RATE_LIMIT_MAX=100 and RATE_LIMIT_TTL=60 that is
 * 100 requests a minute across all users and all tenants: one person
 * doing ordinary work 429s everybody. The window only began firing when
 * ttl was corrected from seconds to milliseconds, which is what armed a
 * bug that until then had been dormant.
 *
 * So key on the address our own outermost proxy saw instead, via
 * `trustedClientIp`, which counts hops from the RIGHT of X-Forwarded-For.
 * Counting from the right is the load-bearing part: every proxy APPENDS,
 * so entries a caller prepends are pushed left and discarded. A caller
 * cannot move themselves into a bucket of their choosing by sending a
 * longer chain, and that is what separates a limit from a formality.
 *
 * Two deliberate choices:
 *
 * - The tracker is IP-only. `ThrottlerGuard` is an APP_GUARD, so it runs
 *   before the controller-scoped auth guards populate `req.user`; there
 *   is no authenticated principal to key on at this point. Reading an
 *   identity out of an unverified Authorization header instead would
 *   hand the bucket straight back to the caller.
 *
 * - When there is no trustworthy address at all, everything lands in one
 *   shared bucket. A global guard has to return something — unlike the
 *   anonymous-surface limiter it cannot skip a scope — and a bucket that
 *   merges throttles harder, never softer.
 */
import { DEFAULT_IPV6_SUBNET_PREFIX, normalizeIp } from '@nestjs/throttler';

import { ClientAddressed, trustedClientIp, trustedProxyHops } from './client-ip';

/**
 * The shared bucket for a request whose origin is not knowable — no
 * X-Forwarded-For, no `req.ip`, no socket address. `trustedClientIp`
 * returns undefined there rather than inventing a key, and a global
 * guard cannot skip a scope, so these merge. Real keys carry an `ip:`
 * prefix, so no forged header can be spelled to collide with this.
 */
export const UNIDENTIFIED_CLIENT_TRACKER = 'unidentified';

export function throttlerTracker(
  req: ClientAddressed,
  hops: number = trustedProxyHops(),
  ipv6SubnetPrefix: number = DEFAULT_IPV6_SUBNET_PREFIX,
): string {
  const ip = trustedClientIp(req, hops);
  if (!ip) return UNIDENTIFIED_CLIENT_TRACKER;

  // normalizeIp is what the library's own default tracker applies, and
  // dropping it would be a quiet regression: it collapses an IPv6
  // address onto its /64 so one client cannot rotate through a subnet
  // for a fresh counter per request.
  return `ip:${normalizeIp(ip, ipv6SubnetPrefix)}`;
}
