/**
 * What each JWT this service signs is for, and how a verifier tells them
 * apart.
 *
 * Every token is signed with the one JWT_SECRET, so the signature alone
 * says nothing about what a token may do. Before these audiences the
 * refresh token (7 days) and the email-verification link token (7 days,
 * delivered in a URL) verified as access tokens on every JwtAuthGuard
 * route: whoever saw the verification link held a week-long session.
 * Each kind now has an audience of its own, and every verifier names the
 * one it accepts.
 */
export const JWT_ISSUER = 'almyty';

/** Access tokens: the session cookie and `Authorization: Bearer`. */
export const ACCESS_TOKEN_AUDIENCE = 'almyty-api';

/** Refresh tokens: redeemable at POST /auth/refresh and nowhere else. */
export const REFRESH_TOKEN_AUDIENCE = 'almyty-refresh';

/** Email verification link tokens: POST/GET /auth/verify-email only. */
export const EMAIL_VERIFY_TOKEN_AUDIENCE = 'almyty-email-verify';

/**
 * Runner credentials: what a hosted runner pod holds instead of a login
 * (runner/runner-credential.ts). Accepted on the hosted runner's own
 * stream and renewal only; the session strategy refuses this audience.
 */
export const RUNNER_CREDENTIAL_AUDIENCE = 'almyty-runner';

/** The one algorithm we sign with, and so the only one we verify. */
export const JWT_ALGORITHM = 'HS256' as const;

/**
 * A verified payload that is an access token. The audience check already
 * refuses the other kinds; this also refuses their claim shapes, so a
 * verifier configured without the audience does not accept them either.
 */
export function isAccessTokenPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const claims = payload as Record<string, unknown>;
  return claims.type === undefined && claims.purpose === undefined;
}
