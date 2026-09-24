import type { VisitorOAuthConfig, VisitorOAuthPreset } from '../../../entities/gateway.entity';
import { hostedChatUrl } from './hosted-chat.config';

/**
 * A hosted chat surface's own OAuth / OIDC provider, for signing visitors
 * in with Google, GitHub, Microsoft, or any OpenID Connect provider.
 *
 * This file is the pure half: presets, validation of what an admin types,
 * the exact redirect URI, and the email-domain rule. The flow itself is
 * VisitorOAuthService; the admin endpoints are VisitorOAuthConfigService.
 */

export const VISITOR_OAUTH_PRESETS: readonly VisitorOAuthPreset[] = Object.freeze(['google', 'github', 'microsoft', 'oidc', 'oauth2']);

/** The outbound fetch for discovery, token, JWKS and user info. Injectable so specs need no network. */
export const VISITOR_OAUTH_FETCH = Symbol('VISITOR_OAUTH_FETCH');
export type OutboundFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Whether a surface has a provider a visitor can actually be sent to. */
export function visitorOAuthConfigured(config: VisitorOAuthConfig | null | undefined): boolean {
  return !!(config && config.clientId && config.credentialId && config.authorizationEndpoint && config.tokenEndpoint);
}

/** Endpoints an admin does not have to type for a named provider. */
export interface PresetEndpoints {
  issuer: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  scopes: string[];
}

/** An Entra tenant: a GUID or a verified domain. Not `common` or `organizations`. */
const ENTRA_TENANT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/;

export function presetEndpoints(preset: VisitorOAuthPreset, tenant?: string | null): PresetEndpoints | null {
  switch (preset) {
    case 'google':
      return {
        issuer: 'https://accounts.google.com',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        scopes: ['openid', 'email', 'profile'],
      };
    case 'github':
      // GitHub is OAuth 2.0 without OpenID Connect: no ID token, identity
      // comes from the API, and the verified address from /user/emails.
      return {
        issuer: null,
        authorizationEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        userinfoEndpoint: 'https://api.github.com/user',
        jwksUri: null,
        scopes: ['read:user', 'user:email'],
      };
    case 'microsoft': {
      // A single tenant only. The multi-tenant endpoints (common,
      // organizations) issue ID tokens whose issuer names each signing
      // tenant, so there is no one issuer to check them against.
      const t = (tenant ?? '').trim().toLowerCase();
      if (!ENTRA_TENANT.test(t)) return null;
      return {
        issuer: `https://login.microsoftonline.com/${t}/v2.0`,
        authorizationEndpoint: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
        tokenEndpoint: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
        userinfoEndpoint: 'https://graph.microsoft.com/oidc/userinfo',
        jwksUri: `https://login.microsoftonline.com/${t}/discovery/v2.0/keys`,
        scopes: ['openid', 'email', 'profile'],
      };
    }
    default:
      return null;
  }
}

/** Whether the provider speaks OpenID Connect (an ID token is expected). */
export function isOidc(config: Pick<VisitorOAuthConfig, 'issuer' | 'preset'>): boolean {
  return config.preset !== 'github' && config.preset !== 'oauth2' && !!config.issuer;
}

/** A human name for the sign-in button. */
export function providerLabel(config: Pick<VisitorOAuthConfig, 'preset' | 'issuer'> | null | undefined): string {
  switch (config?.preset) {
    case 'google':
      return 'Google';
    case 'github':
      return 'GitHub';
    case 'microsoft':
      return 'Microsoft';
    default:
      try {
        return config?.issuer ? new URL(config.issuer).hostname : 'your account';
      } catch {
        return 'your account';
      }
  }
}

/**
 * An endpoint the server will call or send a browser to. HTTPS only: a
 * plain-HTTP token endpoint would carry the client secret and the code in
 * the clear. Where the server itself calls it, the SSRF gate applies too.
 */
export function endpointError(label: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${label} is required.`;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return `${label} is not a valid URL.`;
  }
  if (url.protocol !== 'https:') return `${label} must use https.`;
  if (url.username || url.password) return `${label} must not contain credentials.`;
  if (url.hash) return `${label} must not contain a fragment.`;
  return null;
}

/** Normalise the allowed-domain list: lowercase, no leading @, hostname-shaped, unique. */
export function normalizeEmailDomains(value: unknown): { domains: string[]; error: string | null } {
  if (value === undefined || value === null) return { domains: [], error: null };
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
  if (!raw) return { domains: [], error: 'Allowed email domains must be a list.' };
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { domains: [], error: 'Allowed email domains must be text.' };
    const d = item.trim().toLowerCase().replace(/^@/, '');
    if (!d) continue;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
      return { domains: [], error: `"${item}" is not a domain.` };
    }
    out.add(d);
  }
  if (out.size > 50) return { domains: [], error: 'At most 50 allowed email domains.' };
  return { domains: [...out], error: null };
}

/** Normalise scopes: space or comma separated, printable, unique, bounded. */
export function normalizeScopes(value: unknown, fallback: string[]): { scopes: string[]; error: string | null } {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0) || value === '') {
    return { scopes: [...fallback], error: null };
  }
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
  if (!raw) return { scopes: [], error: 'Scopes must be a list.' };
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return { scopes: [], error: 'Scopes must be text.' };
    const s = item.trim();
    if (!s) continue;
    if (!/^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/.test(s)) return { scopes: [], error: `"${s}" is not a valid scope.` };
    out.add(s);
  }
  if (out.size > 30) return { scopes: [], error: 'At most 30 scopes.' };
  return { scopes: [...out], error: null };
}

/**
 * Whether an address may sign in. Only an address the provider itself
 * vouches for counts: a domain rule checked against a self-typed profile
 * field would admit anyone who typed the right suffix.
 */
export function emailDomainAllowed(
  allowedDomains: string[],
  email: string | null,
  emailVerified: boolean,
): boolean {
  if (!allowedDomains.length) return true;
  if (!email || !emailVerified) return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains.includes(domain);
}

/** The public API prefix the tenant host routes to the API. */
function apiPrefix(env: Record<string, any> = process.env): string {
  return String(env.HOSTED_CHAT_API_PREFIX ?? '/api').replace(/\/$/, '');
}

/**
 * The exact redirect URI for a surface on one host. Built from
 * configuration, never from the request: the host is either the surface's
 * own subdomain or its verified custom domain, and nothing else.
 */
export function visitorOAuthRedirectUri(slug: string, customHostname?: string | null, env?: Record<string, any>): string {
  const origin = customHostname ? `https://${customHostname}` : hostedChatUrl(slug, env);
  return `${origin}${apiPrefix(env)}/public/chat/${slug}/auth/oauth/callback`;
}

/** Every redirect URI an admin registers at the provider for this surface. */
export function visitorOAuthRedirectUris(slug: string, customHostname?: string | null, env?: Record<string, any>): string[] {
  const uris = [visitorOAuthRedirectUri(slug, null, env)];
  if (customHostname) uris.push(visitorOAuthRedirectUri(slug, customHostname, env));
  return uris;
}

/** Reason codes a visitor may be sent back with, and what the page says. */
export const VISITOR_SIGN_IN_ERRORS = Object.freeze({
  SIGN_IN_EXPIRED: 'That sign-in took too long or was started in another browser. Try again.',
  SIGN_IN_DENIED: 'The sign-in was cancelled or refused by the provider.',
  SIGN_IN_FAILED: 'The provider did not confirm who you are. Try again.',
  EMAIL_NOT_ALLOWED: 'This chat only admits accounts from particular email domains.',
  SIGN_IN_UNAVAILABLE: 'Sign-in is not set up for this chat right now.',
});

export type VisitorSignInErrorCode = keyof typeof VISITOR_SIGN_IN_ERRORS;
