'use strict';

/**
 * Whether the staging gate may reuse the QA user's saved browser session.
 *
 * Login is throttled per account, so the gate keeps the session it signed
 * in with (gate-results/.auth/qa.json) and reuses it. Answering
 * /auth/profile is not enough to reuse it: a session that works at setup
 * but ends while the suite runs sends every later test to the sign-in page,
 * where each one times out (40 of them did). So a saved session is reused
 * only if it lasts the whole run; the gate's global setup then opens the
 * app with it and signs in afresh unless the app lands signed in.
 *
 * Nothing here prints or returns the token.
 */

/** How long a reused session must still be good for: longer than any gate run. */
const SESSION_MIN_LEFT_MS = 6 * 3600_000;

/** The `exp` of a JWT, in ms, or null when it is not one. Read only, never verified. */
function jwtExpiryMs(token) {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Whether a cookie's domain covers `host`. */
function cookieCovers(domain, host) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  return h === d || h.endsWith('.' + d);
}

/**
 * Whether a saved Playwright storage state can sign the gate in for the
 * whole run: an `access_token` cookie for the API's host, neither the
 * cookie nor the token in it ending within `minLeftMs`.
 *
 * Returns `{ reuse, reason }`; the reason says why not, without the token.
 *
 * @param {unknown} state a Playwright storage state, as read from its file
 * @param {{ apiUrl?: string, now?: number, minLeftMs?: number }} [options]
 * @returns {{ reuse: boolean, reason: string }}
 */
function savedSessionLasts(state, { apiUrl, now = Date.now(), minLeftMs = SESSION_MIN_LEFT_MS } = {}) {
  const host = apiUrl ? new URL(apiUrl).hostname : null;
  const cookie = (state && Array.isArray(state.cookies) ? state.cookies : []).find(
    (c) => c && c.name === 'access_token' && (!host || cookieCovers(c.domain, host)),
  );
  if (!cookie || !cookie.value) return { reuse: false, reason: 'no saved session cookie for the API' };

  const minutes = (ms) => `${Math.max(0, Math.round((ms - now) / 60_000))} min`;
  // Playwright writes -1 for a cookie that lives as long as the browser.
  if (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires * 1000 - now < minLeftMs) {
    return { reuse: false, reason: `the session cookie ends in ${minutes(cookie.expires * 1000)}` };
  }
  const exp = jwtExpiryMs(cookie.value);
  if (exp === null) return { reuse: false, reason: 'the saved session cookie is not a token the gate can read' };
  if (exp - now < minLeftMs) return { reuse: false, reason: `the saved session ends in ${minutes(exp)}` };
  return { reuse: true, reason: `the saved session lasts ${minutes(exp)}` };
}

module.exports = { SESSION_MIN_LEFT_MS, jwtExpiryMs, savedSessionLasts };
