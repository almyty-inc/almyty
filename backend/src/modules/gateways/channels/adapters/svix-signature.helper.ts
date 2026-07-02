import * as crypto from 'crypto';

/**
 * Svix webhook signature verification. Resend (and other svix-backed
 * providers) sign webhook deliveries with three headers:
 *
 *   svix-id:        unique message id
 *   svix-timestamp: unix seconds at send time
 *   svix-signature: space-separated `v1,<base64>` entries (multiple
 *                   entries appear during secret rotation)
 *
 * The signed content is `${svix-id}.${svix-timestamp}.${rawBody}`,
 * HMAC-SHA256 keyed with the base64-decoded secret (the part after
 * the `whsec_` prefix), base64-encoded. Verification must use the
 * exact raw bytes on the wire, not a re-serialization of the parsed
 * body.
 *
 * Hand-rolled (like twilio-signature.helper.ts) instead of pulling in
 * the `svix` package: the check is ~20 lines of node crypto.
 */

/** Reject webhooks whose svix-timestamp is further than this from now (replay protection). */
export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  const id = headerValue(headers, 'svix-id');
  const timestamp = headerValue(headers, 'svix-timestamp');
  const signatureHeader = headerValue(headers, 'svix-signature');
  if (!id || !timestamp || !signatureHeader || !secret) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return false;

  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();

  return signatureHeader
    .split(/\s+/)
    .filter(Boolean)
    .some((entry) => {
      const [version, sig] = entry.split(',');
      if (version !== 'v1' || !sig) return false;
      const candidate = Buffer.from(sig, 'base64');
      return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    });
}

function headerValue(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  if (headers[name] !== undefined) return headers[name];
  const found = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return found !== undefined ? headers[found] : undefined;
}
