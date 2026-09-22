/**
 * The egress gate for call sites that use `fetch` rather than axios.
 *
 * `ssrfSafeHttpAgent` / `ssrfSafeHttpsAgent` are Node `http.Agent`s. They
 * work on an axios request (`httpAgent`/`httpsAgent`) and on a raw
 * `http.get`, and they do NOTHING for global `fetch` — undici ignores
 * those options, it wants a `Dispatcher`. So every `fetch` call site in
 * this codebase was unpinned by construction, including several whose
 * authors plainly believed otherwise.
 *
 * `ssrfSafeDispatcher` is the undici half: an Agent whose connector
 * resolves through `pinnedLookup`, so a public name whose A record points
 * at `169.254.169.254` or `127.0.0.1` is refused before a socket opens.
 * Pinning at connect rather than resolving separately beforehand is both
 * cheaper and stricter — there is no window between the check and the
 * connection for the answer to change.
 *
 * `assertOutboundUrlAllowed` is the string half, synchronous, for call
 * sites that keep their own transport (they attach the dispatcher or the
 * axios agents themselves).
 *
 * `safeFetch` is both plus `redirect: 'error'` — a public host that
 * answers 302 with an internal `Location` is the standard way around a
 * string-only gate.
 *
 * ## The error is deliberately uniform
 *
 * A refusal says the same thing whatever went wrong. `ECONNREFUSED` vs
 * `EHOSTUNREACH` vs a timeout, and an upstream status code, tell the
 * caller whether a host exists and whether a port is open — a "test
 * connection" button that reports them is an internal port scanner with a
 * UI. `EgressError.message` names the host that was refused (the caller
 * typed it) and nothing about what answered.
 */
import { Agent } from 'undici';

import { pinnedLookup } from './ssrf-safe-agent';
import { validateUrl } from './url-validator';

export class EgressError extends Error {
  readonly code = 'EGRESS_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'EgressError';
  }
}

/**
 * The undici counterpart to `ssrfSafeHttpAgent`. Attach it to a `fetch`
 * call as `{ dispatcher }` (the field is undici's, not in the DOM
 * RequestInit type, so call sites cast).
 */
export const ssrfSafeDispatcher = new Agent({
  connect: { lookup: pinnedLookup as any },
});

/**
 * Refuse a URL the server must not be made to request.
 *
 * Throws `EgressError`. Returns the parsed, normalised URL string.
 */
export function assertOutboundUrlAllowed(urlString: string): string {
  const validation = validateUrl(urlString);
  if (!validation.valid) {
    throw new EgressError(validation.error ?? `Refused to request ${urlString}`);
  }
  return validation.sanitizedUrl!;
}

/**
 * `fetch`, gated. Same signature, minus the ability to follow a redirect.
 *
 * A call site that genuinely needs to chase one re-enters through this
 * function with the new URL.
 */
export async function safeFetch(
  urlString: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = assertOutboundUrlAllowed(urlString);
  return fetch(url, {
    ...init,
    redirect: 'error',
    dispatcher: ssrfSafeDispatcher,
  } as RequestInit);
}

/**
 * What a refused or failed outbound probe may say to the person who asked.
 *
 * Never the errno, never the upstream status: those are the oracle. An
 * `EgressError` keeps its own message, because it is about the URL they
 * typed rather than about what answered.
 */
export function outboundFailureDetail(err: unknown): string {
  if (err instanceof EgressError) return err.message;
  return 'the endpoint could not be reached';
}
