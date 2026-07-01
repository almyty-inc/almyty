import { Request } from 'express';

/**
 * Public base URL of the API (scheme + host, no trailing slash). Prefers the
 * explicit `PUBLIC_API_URL` env (correct behind a reverse proxy / TLS
 * terminator) and falls back to the request's forwarded host.
 */
export function publicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  const proto =
    (req.headers['x-forwarded-proto'] as string)?.split(',')[0] ||
    req.protocol ||
    'https';
  const host = req.get('host');
  return `${proto}://${host}`;
}

/** Where to send the browser after a successful SSO login. */
export function ssoSuccessRedirect(): string {
  return process.env.SSO_SUCCESS_REDIRECT || process.env.FRONTEND_URL || '/';
}

/** Cookie options for the access_token cookie — mirrors AuthController. */
export const SSO_ACCESS_TOKEN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
};

/** Short-lived cookie carrying the OIDC `state` between login and callback. */
export const SSO_STATE_COOKIE = 'sso_oidc_state';
export const SSO_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 10 * 60 * 1000, // 10 minutes
};
