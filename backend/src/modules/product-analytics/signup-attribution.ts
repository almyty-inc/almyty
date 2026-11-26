/**
 * Where a sign-up came from, as the marketing site's link said it: the
 * `utm_*` keys (and `cta`) on a link into /auth/register. The register page
 * reads them from its own URL and sends them with the form; nothing stores
 * them in the browser. They are kept on the user and travel with the
 * sign-up and first-run analytics events.
 *
 * Only these keys, each at most SIGNUP_ATTRIBUTION_MAX_LENGTH characters of
 * a plain identifier alphabet. Anything else is dropped, never an error: a
 * mangled link must not cost anyone their sign-up. `@` is outside the
 * alphabet, so an email address pasted into a link cannot ride along.
 *
 * frontend/src/lib/signup-attribution.ts reads the same keys; keep the two
 * lists equal (signup-attribution.spec.ts checks it).
 */
export const SIGNUP_ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'cta',
] as const;

export type SignupAttributionKey = (typeof SIGNUP_ATTRIBUTION_KEYS)[number];
export type SignupAttribution = Partial<Record<SignupAttributionKey, string>>;

export const SIGNUP_ATTRIBUTION_MAX_LENGTH = 100;

/** Letters, digits, space and `_ - . + ~ : /`. */
const ALLOWED = /^[A-Za-z0-9 _.+~:/-]+$/;

/** The whitelisted, capped attribution in `raw`, or null when nothing usable is there. */
export function sanitizeSignupAttribution(raw: unknown): SignupAttribution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: SignupAttribution = {};
  for (const key of SIGNUP_ATTRIBUTION_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, SIGNUP_ATTRIBUTION_MAX_LENGTH).trim();
    if (!trimmed || !ALLOWED.test(trimmed)) continue;
    out[key] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : null;
}
