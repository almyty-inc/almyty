import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';

/** The one Redis command this needs: SET key value PX ttl NX. */
export interface AtomicSetter {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
}
import { createHash } from 'crypto';
import type { Profile } from '@node-saml/passport-saml';

/**
 * A SAML response is a bearer credential for as long as its assertion is
 * valid. Signature and timestamp checks prove it came from the IdP and is
 * still in date; neither says it has not been used already. Someone who
 * captured one POST (a proxy log, a browser extension, a shared machine's
 * history) could replay it for a fresh session until NotOnOrAfter.
 *
 * So every accepted assertion is recorded by (issuer, assertion ID) until it
 * could no longer be accepted anyway, and a second presentation is refused.
 * The record is a single `SET NX PX`: the check and the claim are one
 * command, so two concurrent posts of the same response cannot both see
 * "not used yet". A read-then-write would have exactly that window.
 */

/** Kept past NotOnOrAfter to cover clock skew between us and the IdP. */
export const SAML_REPLAY_SKEW_MS = 5 * 60 * 1000;

export interface AssertionReplayFacts {
  issuer: string;
  assertionId: string;
  /** Latest instant at which any validity window in the assertion ends. */
  notOnOrAfterMs: number;
}

const first = (value: any) => (Array.isArray(value) ? value[0] : value);

/**
 * Pull the replay key and expiry out of a validated profile.
 *
 * The ID is the Assertion's own `ID` attribute, not the Response's: a
 * replayer can re-wrap a signed assertion in a new unsigned Response, but
 * cannot change the assertion without breaking its signature.
 *
 * The expiry is the later of the Conditions and SubjectConfirmationData
 * NotOnOrAfter, since the assertion stays acceptable until both have
 * passed. An assertion with neither has no end to its validity, and so no
 * point at which forgetting it would be safe: it is refused.
 */
export function assertionReplayFacts(profile: Profile): AssertionReplayFacts {
  const parsed: any = typeof (profile as any).getAssertion === 'function' ? (profile as any).getAssertion() : null;
  const assertion = parsed?.Assertion;
  const assertionId: unknown = assertion?.$?.ID;
  if (typeof assertionId !== 'string' || !assertionId) {
    throw new UnauthorizedException('SAML assertion has no ID');
  }

  const bounds: number[] = [];
  const conditions = first(assertion.Conditions);
  if (conditions?.$?.NotOnOrAfter) bounds.push(Date.parse(conditions.$.NotOnOrAfter));
  for (const confirmation of assertion.Subject?.[0]?.SubjectConfirmation ?? []) {
    for (const data of confirmation?.SubjectConfirmationData ?? []) {
      if (data?.$?.NotOnOrAfter) bounds.push(Date.parse(data.$.NotOnOrAfter));
    }
  }
  const valid = bounds.filter((b) => Number.isFinite(b));
  if (!valid.length) {
    throw new UnauthorizedException('SAML assertion has no expiry (NotOnOrAfter)');
  }

  const issuer =
    (typeof profile.issuer === 'string' && profile.issuer) ||
    (typeof first(assertion.Issuer)?._ === 'string' && first(assertion.Issuer)._) ||
    (typeof first(assertion.Issuer) === 'string' && first(assertion.Issuer)) ||
    '';
  return { issuer, assertionId, notOnOrAfterMs: Math.max(...valid) };
}

@Injectable()
export class SamlReplayCache {
  private readonly logger = new Logger(SamlReplayCache.name);

  constructor(@InjectRedis() private readonly redis: AtomicSetter) {}

  static keyFor(facts: Pick<AssertionReplayFacts, 'issuer' | 'assertionId'>): string {
    // Hashed: both values come from the IdP and may be long or contain
    // anything; the key only has to be stable and collision free.
    const digest = createHash('sha256').update(`${facts.issuer}\n${facts.assertionId}`).digest('hex');
    return `sso:saml:consumed:${digest}`;
  }

  /**
   * Claim an assertion. True exactly once per (issuer, ID) while the record
   * lives; false for every later presentation. Fails closed: if the claim
   * cannot be recorded the sign-in is refused, since accepting it would
   * leave it replayable.
   */
  async consume(facts: AssertionReplayFacts, nowMs: number = Date.now()): Promise<boolean> {
    // The validator already refused an expired assertion, so this is
    // positive in practice; the floor keeps SET from rejecting a zero TTL
    // for one that expires in the same millisecond.
    const ttlMs = Math.max(1000, facts.notOnOrAfterMs - nowMs + SAML_REPLAY_SKEW_MS);
    let reply: string | null;
    try {
      reply = await this.redis.set(SamlReplayCache.keyFor(facts), String(nowMs), 'PX', ttlMs, 'NX');
    } catch (err) {
      this.logger.error(`Could not record SAML assertion use: ${err}`);
      throw new ServiceUnavailableException('Single sign-on is temporarily unavailable. Try again shortly.');
    }
    return reply === 'OK';
  }
}
