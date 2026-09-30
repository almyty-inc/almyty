/**
 * The signing secret every module falls back to when JWT_SECRET is unset
 * (local dev and tests; production refuses to start without it).
 *
 * One value, because a session cookie signed by one module is verified by
 * another: AuthModule signs it, JwtStrategy verifies it on every route,
 * and the MCP consent step runs that same strategy. Separate fallbacks
 * meant a dev or CI install without JWT_SECRET could sign a cookie that
 * nothing else accepted.
 */
export const DEV_ONLY_JWT_SECRET = 'dev-only-jwt-secret-change-me-in-production';

/**
 * The configured JWT_SECRET, or DEV_ONLY_JWT_SECRET outside production.
 *
 * Every module that signs or verifies a session token resolves its secret
 * here. In production an unset secret, or the dev value itself (which is
 * in this public repository), refuses to start: a verifier that quietly
 * fell back would accept tokens anyone can sign.
 */
export function jwtSecretOrDevFallback(secret: string | undefined | null, who: string): string {
  const production = process.env.NODE_ENV === 'production';
  if (production && (!secret || secret === DEV_ONLY_JWT_SECRET)) {
    throw new Error(
      `JWT_SECRET must be set to a secret of your own in production (${who}). ` +
        'Refusing to start with an undefined or published signing key.',
    );
  }
  return secret || DEV_ONLY_JWT_SECRET;
}