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

/** Why a dashboard SSO sign-in did not complete, as the sign-in error page names it. */
export type SsoFailureCode =
  | 'deactivated'
  | 'not_member'
  | 'invite_pending'
  | 'no_account'
  | 'domain_unverified'
  | 'expired'
  | 'not_enabled'
  | 'not_entitled'
  | 'failed';

/**
 * The reason, from the refusal's own words. Only a code travels to the
 * page (which words it in its own text), so a crafted link cannot put a
 * message of someone else's choosing on our sign-in page.
 */
export function ssoFailureCode(err: unknown): SsoFailureCode {
  const e = err as { message?: string; getStatus?: () => number; getResponse?: () => any };
  const response = typeof e?.getResponse === 'function' ? e.getResponse() : null;
  const text = `${e?.message ?? ''} ${typeof response === 'object' && response ? `${response.message ?? ''} ${response.code ?? ''}` : ''}`;
  if (/SSO_NOT_ENTITLED|not included in this organization plan/i.test(text)) return 'not_entitled';
  if (/deactivated/i.test(text)) return 'deactivated';
  if (/not a member of this organization/i.test(text)) return 'not_member';
  if (/invitation to this organization has not been accepted/i.test(text)) return 'invite_pending';
  if (/No account exists for this identity/i.test(text)) return 'no_account';
  if (/not on a domain your organization has verified/i.test(text)) return 'domain_unverified';
  if (/SSO is not enabled|not fully configured|is not configured/i.test(text)) return 'not_enabled';
  if (/expired|Start again|already been used|does not answer this sign-in/i.test(text)) return 'expired';
  return 'failed';
}

/**
 * The sign-in error page for a refused or broken SSO sign-in, instead of a
 * raw JSON error in the browser. `SSO_ERROR_REDIRECT` overrides it; by
 * default it is the frontend's /auth/sso-error.
 */
export function ssoErrorRedirect(code: SsoFailureCode): string {
  const base =
    process.env.SSO_ERROR_REDIRECT ||
    `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/auth/sso-error`;
  return `${base}${base.includes('?') ? '&' : '?'}reason=${encodeURIComponent(code)}`;
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
/** Short-lived cookie carrying a dashboard SAML sign-in's relay state (SamlSignInStore). */
export const SSO_SAML_STATE_COOKIE = 'sso_saml_state';
export const SSO_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 10 * 60 * 1000, // 10 minutes
};
