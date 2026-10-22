import { createHmac, timingSafeEqual } from 'crypto';
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';

import { safeFetch } from '../../../../common/security/safe-fetch';
import { renderText } from './push-wake-template';
import { hmacToleranceSeconds, type PushHeaderRule, type PushVerification, type PushWakeSpec } from './push-wake.types';

/**
 * Checking that a push came from the service (push-wake.types.ts). Every
 * check fails closed: a missing header, a missing secret, an unreachable
 * key set are all "not verified".
 */

export interface InboundPush {
  /** Header names lower-cased. */
  headers: Record<string, string | undefined>;
  /** The body exactly as it arrived (signatures are over these bytes). */
  rawBody: string;
}

/** Verified (with the token's claims, for a signed token), or why not. */
export interface VerifyOutcome {
  ok: boolean;
  reason?: string;
  claims?: Record<string, unknown>;
}

/** Where an OIDC verifier gets the issuer's keys; tests hand in a local key set. */
export type KeySetFor = (jwksUrl: string) => JWTVerifyGetKey;

const keySets = new Map<string, JWTVerifyGetKey>();

/** The issuer's published keys, cached per URL and fetched through the outbound guard. */
export const remoteKeySet: KeySetFor = (jwksUrl) => {
  let keys = keySets.get(jwksUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUrl), {
      [customFetch]: (url, options) => safeFetch(String(url), { ...(options as any), maxBytes: 262_144, timeoutMs: 10_000 }) as any,
      timeoutDuration: 10_000,
      cacheMaxAge: 10 * 60_000,
    });
    if (keySets.size >= 64) keySets.delete(keySets.keys().next().value as string);
    keySets.set(jwksUrl, keys);
  }
  return keys;
};

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function header(push: InboundPush, name: string): string | undefined {
  const v = push.headers[name.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

export async function verifyPush(
  verification: PushVerification,
  push: InboundPush,
  context: { secret: string | null; endpointUrl: string; templateContext: Record<string, unknown> },
  keySetFor: KeySetFor = remoteKeySet,
  now: Date = new Date(),
): Promise<VerifyOutcome> {
  if (verification.method === 'shared_token') {
    const sent = header(push, verification.headerName);
    if (!context.secret) return { ok: false, reason: 'no shared value is set up' };
    if (!sent) return { ok: false, reason: `no ${verification.headerName} header` };
    return equal(sent, context.secret) ? { ok: true } : { ok: false, reason: `${verification.headerName} does not match` };
  }

  if (verification.method === 'hmac') {
    if (!context.secret) return { ok: false, reason: 'no signing key is set up' };
    let sent = header(push, verification.headerName);
    if (!sent) return { ok: false, reason: `no ${verification.headerName} header` };
    if (verification.prefix) {
      if (!sent.startsWith(verification.prefix)) return { ok: false, reason: 'the signature is not in the expected form' };
      sent = sent.slice(verification.prefix.length);
    }
    if (verification.timestampHeader) {
      const ts = Number(header(push, verification.timestampHeader));
      const tolerance = verification.toleranceSeconds ?? hmacToleranceSeconds();
      if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > tolerance) return { ok: false, reason: 'the push is too old or has no time' };
    }
    const content = renderText(verification.signedContent, {
      ...context.templateContext,
      body: push.rawBody,
      headers: push.headers,
    });
    const expected = createHmac(verification.algorithm, context.secret).update(content, 'utf8').digest(verification.encoding);
    return equal(sent.trim(), expected) ? { ok: true } : { ok: false, reason: 'the signature does not match' };
  }

  const auth = header(push, 'authorization') ?? '';
  const token = auth.slice(0, 7).toLowerCase() === 'bearer ' ? auth.slice(7).trim() : '';
  if (!token || token.length > 16_384) return { ok: false, reason: 'no bearer token' };
  const audience = verification.audience ? renderText(verification.audience, context.templateContext) : context.endpointUrl;
  if (!audience) return { ok: false, reason: 'no audience to check against' };
  // Said plainly before the signature is checked: an expired token is the
  // usual reason a push stops working (a clock, a replayed delivery).
  let unverified: Record<string, unknown>;
  try {
    unverified = decodeJwt(token) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'the bearer value is not a signed token' };
  }
  if (typeof unverified.exp === 'number' && unverified.exp * 1000 + 5000 < now.getTime()) return { ok: false, reason: 'the token has expired' };
  try {
    const { payload } = await jwtVerify(token, keySetFor(verification.jwksUrl), {
      issuer: verification.issuers,
      audience,
      algorithms: ['RS256', 'ES256', 'PS256'],
      requiredClaims: ['exp', 'iat'],
      clockTolerance: 5,
      currentDate: now,
    });
    for (const [claim, template] of Object.entries(verification.claims ?? {})) {
      const want = renderText(template, context.templateContext);
      if (!want) return { ok: false, reason: `nothing set up to check ${claim} against` };
      const got = (payload as Record<string, unknown>)[claim];
      if (got === undefined || String(got).toLowerCase() !== want.toLowerCase()) return { ok: false, reason: `${claim} is not the one set up` };
    }
    return { ok: true, claims: payload as Record<string, unknown> };
  } catch (err: any) {
    return { ok: false, reason: `the token does not verify (${err?.code ?? err?.message ?? 'invalid'})` };
  }
}

/** Whether the push passes the header rules; the first rule it fails, or null. */
export function failedRule(rules: PushHeaderRule[] | undefined, push: InboundPush, templateContext: Record<string, unknown>): PushHeaderRule | null {
  for (const rule of rules ?? []) {
    const value = header(push, rule.header);
    const accepted = rule.oneOf.map((t) => renderText(t, templateContext)).filter(Boolean);
    if (value === undefined || !accepted.includes(value)) return rule;
  }
  return null;
}

/** Whether a push is one the spec says to acknowledge and ignore. */
export function ignored(spec: Pick<PushWakeSpec, 'ignore'>, push: InboundPush, templateContext: Record<string, unknown>): boolean {
  return (spec.ignore ?? []).some((rule) => {
    const value = header(push, rule.header);
    return value !== undefined && rule.oneOf.map((t) => renderText(t, templateContext)).includes(value);
  });
}
