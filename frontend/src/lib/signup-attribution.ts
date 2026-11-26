/**
 * Where a sign-up came from, read from the register page's own URL: the
 * marketing site links to /auth/register?utm_source=…&cta=…, and the page
 * sends these values with the form. Nothing here is stored: no cookie, no
 * localStorage, no sessionStorage. Reload the page without them and they
 * are gone.
 *
 * Same keys, cap and alphabet as the backend
 * (backend/src/modules/product-analytics/signup-attribution.ts), which
 * checks them again and is the one that counts; a spec there keeps the two
 * lists equal.
 */
export const SIGNUP_ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'cta'] as const

export type SignupAttributionKey = (typeof SIGNUP_ATTRIBUTION_KEYS)[number]
export type SignupAttribution = Partial<Record<SignupAttributionKey, string>>

export const SIGNUP_ATTRIBUTION_MAX_LENGTH = 100

/** Letters, digits, space and `_ - . + ~ : /`. */
const ALLOWED = /^[A-Za-z0-9 _.+~:/-]+$/

/** The whitelisted, capped attribution in the query, or undefined when it carries none. */
export function readSignupAttribution(params: URLSearchParams): SignupAttribution | undefined {
  const out: SignupAttribution = {}
  for (const key of SIGNUP_ATTRIBUTION_KEYS) {
    const value = params.get(key)?.trim().slice(0, SIGNUP_ATTRIBUTION_MAX_LENGTH).trim()
    if (!value || !ALLOWED.test(value)) continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}
