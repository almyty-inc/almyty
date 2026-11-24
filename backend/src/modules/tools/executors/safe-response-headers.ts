/**
 * The upstream response headers a tool result may carry.
 *
 * A tool's result leaves the executor: the tool test page, the skills
 * gateway, UTCP error details, the result cache. The upstream's raw
 * headers carry its session (`set-cookie`), CSRF tokens and auth
 * challenges, none of which is ours to hand on. Only headers that say
 * something about the answer itself are kept: an allowlist, with a
 * name check on top so a future allowlist entry cannot let a secret
 * through. Pagination reads the raw axios response, not this.
 */

const ALLOWED = new Set([
  'content-type',
  'content-length',
  'content-language',
  'content-encoding',
  'content-disposition',
  'etag',
  'last-modified',
  'cache-control',
  'expires',
  'age',
  'vary',
  'location',
  'link',
  'retry-after',
  'date',
  'request-id',
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
  'x-total-count',
  'x-total',
  'x-page',
  'x-per-page',
  'x-next-page',
  'ratelimit',
  'ratelimit-policy',
]);

const ALLOWED_PREFIXES = ['x-ratelimit-', 'x-rate-limit-', 'ratelimit-'];

const SENSITIVE = /token|secret|session|cookie|auth|api[-_]?key|csrf|xsrf|password|signature/i;

export function isSafeResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE.test(lower)) return false;
  return ALLOWED.has(lower) || ALLOWED_PREFIXES.some((p) => lower.startsWith(p));
}

/** The allowed headers of an upstream response, names lower-cased; undefined for none. */
export function safeResponseHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  // AxiosHeaders keeps its entries on the instance; toJSON flattens them.
  const source: Record<string, unknown> =
    typeof (headers as any).toJSON === 'function' ? (headers as any).toJSON() : (headers as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    if (value === undefined || value === null || !isSafeResponseHeader(name)) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** A tool result with its metadata's headers reduced to the safe ones. */
export function withSafeResponseHeaders<T extends { metadata?: Record<string, any> }>(result: T): T {
  if (!result?.metadata || !('headers' in result.metadata)) return result;
  const headers = safeResponseHeaders(result.metadata.headers);
  const { headers: _raw, ...rest } = result.metadata;
  return { ...result, metadata: headers ? { ...rest, headers } : rest };
}
