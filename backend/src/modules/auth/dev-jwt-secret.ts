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
