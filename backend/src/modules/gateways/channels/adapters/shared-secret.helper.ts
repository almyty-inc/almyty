import * as crypto from 'crypto';

/**
 * Whether an inbound request presented the channel's shared secret.
 *
 * For the relays that authenticate a webhook with a static value in a
 * header rather than a signature over the body (Sendblue's
 * `sb-signing-secret`, LoopMessage's configured `Authorization`).
 * Constant time, and false whenever either side is missing or empty:
 * an unconfigured secret refuses everything rather than nothing.
 */
export function sharedSecretMatches(presented: unknown, expected: unknown): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
