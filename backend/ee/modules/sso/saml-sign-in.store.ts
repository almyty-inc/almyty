import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { randomBytes, timingSafeEqual } from 'crypto';

/** The Redis commands the SAML hand-off needs. ioredis has both. */
export interface SamlHandoffStore {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
}

/** How long a started sign-in waits for the IdP's response. */
export const SAML_SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** How long a validated response waits for the browser that started it. */
export const SAML_HANDOFF_TTL_MS = 2 * 60 * 1000;

/** What every started sign-in remembers: the AuthnRequest it sent and where the answer must arrive. */
export interface PendingSamlSignIn {
  requestId: string;
  acsUrl: string;
}

/** A validated response, parked for the browser holding `relayState`. */
export interface ParkedSamlSignIn {
  relayState: string;
}

/**
 * The two-step SAML sign-in shared by the dashboard login and hosted-chat
 * visitors. Every SAML sign-in here is SP-initiated; there is no
 * IdP-initiated mode.
 *
 * 1. Starting a sign-in stores the AuthnRequest ID and the ACS URL under a
 *    fresh random relay state, for SAML_SIGN_IN_TTL_MS, and the browser
 *    gets the relay state in a cookie. The IdP echoes it as RelayState.
 * 2. The assertion consumer takes that record (GETDEL: single use) and
 *    accepts only a response that answers exactly that request
 *    (InResponseTo) at exactly that ACS (Recipient, Destination). A
 *    response with no relay state, or one we never issued, is unsolicited
 *    and refused.
 * 3. The IdP's POST is cross-site, so it carries no SameSite=Lax cookie
 *    and cannot say whose browser it is. The consumer therefore parks the
 *    validated identity for SAML_HANDOFF_TTL_MS under a one-time hand-off
 *    and redirects to a GET on the same host, which does carry cookies.
 *    That GET completes the sign-in only in the browser whose state
 *    cookie holds the relay state the sign-in began with. A response
 *    captured by an attacker and posted into a victim's browser (login
 *    CSRF) therefore signs nobody in.
 *
 * `scope` keeps the two flows' records apart.
 */
@Injectable()
export class SamlSignInStore {
  constructor(@InjectRedis() private readonly redis: SamlHandoffStore) {}

  static newRelayState(): string {
    return randomBytes(32).toString('hex');
  }

  /** Remember a started sign-in. False when it could not be stored (the sign-in must not proceed). */
  async remember<T extends PendingSamlSignIn>(scope: string, relayState: string, pending: T): Promise<boolean> {
    const stored = await this.redis.set(`${scope}:saml:relay:${relayState}`, JSON.stringify(pending), 'PX', SAML_SIGN_IN_TTL_MS, 'NX');
    return stored === 'OK';
  }

  /** Taken, not read: a relay state answers one response, whatever it says. */
  async takePending<T extends PendingSamlSignIn>(scope: string, relayState: unknown): Promise<T | null> {
    if (typeof relayState !== 'string' || !relayState) return null;
    const raw = await this.redis.getdel(`${scope}:saml:relay:${relayState}`);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /** Park a validated sign-in; returns the hand-off id, or null when it could not be stored. */
  async park<T extends ParkedSamlSignIn>(scope: string, record: T): Promise<string | null> {
    const handoff = randomBytes(32).toString('hex');
    const stored = await this.redis.set(`${scope}:saml:handoff:${handoff}`, JSON.stringify(record), 'PX', SAML_HANDOFF_TTL_MS, 'NX');
    return stored === 'OK' ? handoff : null;
  }

  /**
   * Take a parked sign-in for the browser presenting `stateCookie`. The
   * hand-off is spent whether or not the cookie matches, so a link sent to
   * the wrong browser is dead for the right one too.
   */
  async takeHandoff<T extends ParkedSamlSignIn>(scope: string, handoff: unknown, stateCookie: unknown): Promise<T | null> {
    if (typeof handoff !== 'string' || !handoff) return null;
    const raw = await this.redis.getdel(`${scope}:saml:handoff:${handoff}`);
    const record = raw ? (JSON.parse(raw) as T) : null;
    return record && sameSecret(stateCookie, record.relayState) ? record : null;
  }
}

function sameSecret(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
