/**
 * Content-Security-Policy directives the backend sends through helmet.
 *
 * For the split deployment this only guards JSON responses: the browser
 * gets the SPA from the frontend nginx image, whose policy lives in
 * frontend/nginx-security-headers.inc. In the all-in-one image
 * (SERVE_FRONTEND=true) the backend serves the SPA itself, so these
 * directives must admit the same third parties that file does, or the page
 * breaks the same way production did.
 *
 * helmet merges these over its defaults (base-uri, form-action,
 * frame-ancestors, object-src, script-src-attr, upgrade-insecure-requests,
 * and font-src 'self' https: data:, which already admits Google Fonts files,
 * stay as helmet sets them).
 */

/** Cloudflare Turnstile: script-src + frame-src, as Cloudflare documents. */
export const TURNSTILE_SOURCES = ['https://challenges.cloudflare.com'];
/** hCaptcha: script/frame/style/connect-src, as hCaptcha documents. */
export const HCAPTCHA_SOURCES = ['https://hcaptcha.com', 'https://*.hcaptcha.com'];
/** Sentry's ingest hosts, where the SPA sends error reports. */
const SENTRY_SOURCES = ['https://*.ingest.de.sentry.io', 'https://*.ingest.sentry.io'];

export const CSP_DIRECTIVES: Record<string, string[]> = {
  defaultSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', ...HCAPTCHA_SOURCES],
  scriptSrc: ["'self'", ...TURNSTILE_SOURCES, ...HCAPTCHA_SOURCES],
  imgSrc: ["'self'", 'data:', 'https:'],
  connectSrc: ["'self'", ...SENTRY_SOURCES, ...HCAPTCHA_SOURCES],
  frameSrc: ["'self'", ...TURNSTILE_SOURCES, ...HCAPTCHA_SOURCES],
};
