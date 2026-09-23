/**
 * The client address of a request, for controls that must not be
 * forgeable.
 *
 * Every public surface here derived it as `x-forwarded-for.split(',')[0]`
 * — the LEFTMOST hop. That is the one entry in the header the client
 * writes. Express `trust proxy` is off (see referrals.constants.ts), so
 * nothing validated it either, which made the per-IP rate limit on the
 * anonymous chat surfaces a bucket the caller chose: send
 * `X-Forwarded-For: 10.0.0.<random>` and every request lands in a fresh
 * counter. Those surfaces start an LLM run on the tenant's own provider
 * keys, so a limit whose key the caller picks is not a limit.
 *
 * X-Forwarded-For grows left to right: each proxy APPENDS the address it
 * received the connection from. So the trustworthy entry is counted from
 * the RIGHT — the rightmost is the address our own outermost proxy saw,
 * and with N proxies in front of the app the client's real address is
 * the Nth from the right. Everything to the left of that was written by
 * something we do not control and is discarded.
 *
 * `TRUSTED_PROXY_HOPS` is that N, default 1 (a single ingress). Raise it
 * by one for each ADDITIONAL trusted proxy that appends a hop — a CDN or
 * an L7 load balancer in front of the ingress. Setting it too high hands
 * control back to the client; setting it too low collapses distinct
 * visitors onto a proxy's own address, which over-throttles rather than
 * under-throttles. It fails in that direction on purpose.
 */

/** Requests carry only what this needs; keeps the helper testable. */
export interface ClientAddressed {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}

export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TRUSTED_PROXY_HOPS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_TRUSTED_PROXY_HOPS;
  return Math.floor(raw);
}

/**
 * The caller's address as the outermost trusted proxy saw it, or
 * undefined when there is nothing trustworthy to report.
 *
 * Returning undefined rather than a guess matters: the rate limiter
 * skips a scope whose id is absent, and a fabricated id would be worse
 * than a skipped scope because it would look like a control.
 */
export function trustedClientIp(
  req: ClientAddressed,
  hops: number = trustedProxyHops(),
): string | undefined {
  const raw = req.headers?.['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;

  if (header) {
    const chain = header
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (chain.length > 0) {
      // Index from the right. A chain shorter than the configured hop
      // count means fewer proxies appended than we were told to expect;
      // clamping to the leftmost entry is the conservative reading,
      // because merging two visitors throttles harder, never softer.
      return chain[Math.max(0, chain.length - hops)];
    }
  }

  // No header at all: a direct connection (local dev, an in-cluster
  // probe). The socket address is then the client's.
  return req.ip || req.socket?.remoteAddress || undefined;
}
