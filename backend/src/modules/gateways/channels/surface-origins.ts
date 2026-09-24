/**
 * Which third-party sites may call a public chat surface from the browser.
 *
 * The chat widget lives in someone else's page, so its calls to us are
 * cross-origin by construction, and the browser only lets the page read
 * our answers if we say that page's origin may. The list is per gateway:
 * a tenant names the sites their widget is embedded on, and nothing else
 * gets a CORS answer. An empty list is same-origin only -- fail closed.
 *
 * Exact origins only: scheme, host and port, nothing else. No wildcards,
 * not even `https://*.example.com`: telling a subdomain wildcard apart
 * from `https://*.co.uk` needs the public suffix list, and a wildcard also
 * hands the surface to every forgotten subdomain a third party could take
 * over. A tenant with several sites lists them.
 *
 * These answers are never credentialed. The widget sends no cookies, and
 * a hosted-chat visitor's session cookie is scoped to the surface's own
 * host; a third-party page must not be able to ride it.
 */

/** Where the list lives on a gateway's configuration. */
export const ALLOWED_ORIGINS_KEY = 'allowedOrigins';

/** Enough for a tenant with many sites, small enough to scan per request. */
export const MAX_ALLOWED_ORIGINS = 50;

/**
 * The canonical form of an origin, or an explanation of why the value is
 * not one. The canonical form is what the browser sends in `Origin`:
 * lowercase scheme and host, default port dropped, no trailing slash.
 */
export function parseOrigin(input: unknown): { origin: string } | { error: string } {
  if (typeof input !== 'string') return { error: 'An origin must be text.' };
  const value = input.trim();
  if (!value) return { error: 'Enter an origin, for example https://www.example.com.' };
  if (value.length > 300) return { error: 'That origin is too long.' };
  if (value.includes('*')) {
    return { error: 'Wildcards are not supported. List each site, for example https://www.example.com.' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: `"${value}" is not an origin. Use the form https://www.example.com.` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'Only http and https sites can embed the chat.' };
  }
  if (url.username || url.password) return { error: 'An origin cannot contain a user name or password.' };
  if (!url.hostname) return { error: 'An origin needs a host.' };
  // Anything past the authority means the value was a URL, not an origin.
  // A trailing slash is the one thing people paste that is harmless.
  if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(value) || /^[a-z]+:\/\/[^/]+\/./i.test(value)) {
    return { error: `Use the origin only, without a path: ${url.origin}` };
  }
  // URL.origin is the browser's own serialisation: lowercase host, default
  // port dropped, IDN in punycode. Exactly what arrives in `Origin`.
  return { origin: url.origin };
}

/**
 * Validate a list as submitted. Returns the canonical, de-duplicated list,
 * or the first problem found, named by position so the UI can point at it.
 */
export function normalizeAllowedOrigins(
  value: unknown,
): { origins: string[] } | { error: string } {
  if (value === undefined || value === null) return { origins: [] };
  if (!Array.isArray(value)) return { error: 'Allowed origins must be a list.' };
  if (value.length > MAX_ALLOWED_ORIGINS) {
    return { error: `At most ${MAX_ALLOWED_ORIGINS} allowed origins.` };
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const parsed = parseOrigin(value[i]);
    if ('error' in parsed) return { error: `Allowed origin ${i + 1}: ${parsed.error}` };
    if (!out.includes(parsed.origin)) out.push(parsed.origin);
  }
  return { origins: out };
}

/** The stored list, tolerating a missing or malformed value as empty. */
export function allowedOriginsOf(configuration: Record<string, any> | null | undefined): string[] {
  const raw = configuration?.[ALLOWED_ORIGINS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is string => typeof o === 'string');
}

/**
 * Whether a request's Origin header is on the list. The header is parsed
 * and canonicalised the same way the list was, then compared exactly;
 * there is no prefix, suffix or pattern match anywhere.
 */
export function originIsAllowed(allowed: readonly string[], originHeader: string | undefined): boolean {
  if (!originHeader) return false;
  const parsed = parseOrigin(originHeader);
  if ('error' in parsed) return false;
  return allowed.includes(parsed.origin);
}
