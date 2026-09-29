/**
 * Cross-site request forgery check for cookie-authenticated requests.
 *
 * The web client's session is the `access_token` cookie, and a browser
 * attaches it to any request to this host, whoever's page makes it. The
 * cookie is SameSite=Lax, which keeps it off cross-SITE POSTs, but a
 * "site" is the registrable domain: every subdomain of ours (a docs host,
 * a marketing page, anything ever taken over) is the same site, and can
 * submit a form to the API with the user's cookie attached. CORS does not
 * help there: it decides what a page may read, not what the API does, and
 * a plain form POST needs no preflight.
 *
 * So an unsafe request that carries the session cookie must come from an
 * origin the API serves: one of the dashboard origins CORS already
 * trusts, or the API's own origin (the single-image deployment serves the
 * SPA from it). Browsers send `Origin` on every POST, PUT, PATCH and
 * DELETE; `Referer` stands in when a privacy setting strips it. A request
 * with neither is not a browser's, and a request without the cookie is
 * not riding anyone's session; both pass.
 *
 * The SAML assertion consumers are exempt: an IdP posts to them from its
 * own origin by design, they authenticate the signed assertion rather
 * than the cookie, and they only ever start a session.
 */
import type { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE = 'access_token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const IDP_POST_TARGETS = [/\/saml\/callback\/?$/, /\/saml\/acs\/?$/];

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Why an unsafe cookie-authenticated request is refused, or null when it may proceed. */
export function csrfRefusal(req: Pick<Request, 'method' | 'path' | 'headers' | 'cookies'>, allowedOrigins: ReadonlySet<string>): string | null {
  if (SAFE_METHODS.has((req.method || 'GET').toUpperCase())) return null;
  if (!req.cookies?.[SESSION_COOKIE]) return null;
  if (IDP_POST_TARGETS.some((pattern) => pattern.test(req.path || ''))) return null;

  const originHeader = headerValue(req.headers.origin);
  const refererHeader = headerValue(req.headers.referer);
  if (originHeader === undefined && refererHeader === undefined) return null;

  // `Origin: null` (sandboxed frames, some redirects) is an origin we
  // cannot vouch for, not an absent one.
  const origin = originHeader !== undefined ? originOf(originHeader) : originOf(refererHeader);
  if (!origin) return 'unrecognised origin';
  if (allowedOrigins.has(origin)) return null;

  const host = new URL(origin).host;
  const hosts = [headerValue(req.headers['x-forwarded-host']), headerValue(req.headers.host)]
    .flatMap((value) => (value ? value.split(',') : []))
    .map((value) => value.trim().toLowerCase());
  if (hosts.includes(host.toLowerCase())) return null;

  return `origin ${origin} is not allowed`;
}

export function csrfOriginCheck(allowedOrigins: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const refusal = csrfRefusal(req, allowedOrigins);
    if (!refusal) {
      next();
      return;
    }
    res.status(403).json({
      statusCode: 403,
      code: 'CSRF_ORIGIN_REFUSED',
      message: 'This request did not come from an allowed origin.',
    });
  };
}
