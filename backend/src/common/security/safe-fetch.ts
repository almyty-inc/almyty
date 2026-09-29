/**
 * The one guarded client for an outbound request whose URL a user, a
 * tenant or a visitor can influence.
 *
 * `ssrfSafeHttpAgent` / `ssrfSafeHttpsAgent` are Node `http.Agent`s. They
 * work on an axios request (`httpAgent`/`httpsAgent`) and on a raw
 * `http.get`, and they do NOTHING for global `fetch` — undici ignores
 * those options, it wants a `Dispatcher`. `ssrfSafeDispatcher` is the
 * undici half: an Agent whose connector resolves through `pinnedLookup`,
 * so a public name whose A record points at `169.254.169.254` or
 * `127.0.0.1` is refused before a socket opens. Pinning at connect rather
 * than resolving separately beforehand leaves no window between the check
 * and the connection for the answer to change (DNS rebinding).
 *
 * `safeFetch` puts every part of the gate on one request:
 *
 *   - the string gate (`validateUrl`): http(s) only, no credentials in the
 *     URL, no private / loopback / link-local / metadata address in any
 *     spelling (decimal, octal, hex, IPv4-mapped IPv6, ...);
 *   - the DNS pin on the connection;
 *   - redirects refused, or, when a caller asks for `maxRedirects`, taken
 *     one hop at a time with every hop back through the string gate and
 *     the pin. A public host that answers 302 with an internal `Location`
 *     is the standard way around a string-only gate;
 *   - a TOTAL deadline. An idle timeout (axios `timeout`, undici's
 *     body timeout) is reset by every byte, so a server that drips one
 *     byte a second holds the request, and whatever worker awaits it,
 *     for as long as it likes;
 *   - a response-size cap, enforced on the decompressed stream, so a huge
 *     or endless body cannot be buffered into the API process by a later
 *     `.text()` / `.json()`.
 *
 * The one relaxation is `privateHost`: a single host, matched exactly,
 * that an explicit opt-in (an install-wide env flag such as
 * `MCP_ALLOW_PRIVATE_URLS`, or an organization's egress allowlist) lets
 * resolve to a private address. Every other host -- including every
 * redirect hop to a different name -- is held to the full gate.
 *
 * `assertOutboundUrlAllowed` is the string half, synchronous, for call
 * sites that keep their own transport (they attach the dispatcher or the
 * axios agents themselves; `egressAxiosConfig` in pinned-redirects.ts is
 * the axios counterpart of this function).
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

import { dispatcherExempting } from './exempt-dispatcher';
import { stripBrackets } from './ip-classification';
import { pinnedLookup } from './ssrf-safe-agent';
import { validateUrl, validateUrlAllowingPrivate } from './url-validator';

export class EgressError extends Error {
  readonly code: string = 'EGRESS_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'EgressError';
  }
}

/** The response was bigger than the caller's cap; reading stopped there. */
export class ResponseTooLargeError extends EgressError {
  readonly code = 'RESPONSE_TOO_LARGE';
  constructor(readonly maxBytes: number) {
    super(`The response exceeded the ${maxBytes}-byte limit`);
    this.name = 'ResponseTooLargeError';
  }
}

/** What a caller gets when it names no cap. Every call site here reads JSON or a document. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** What a caller gets when it names no deadline: for the whole exchange, body included. */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;
/** Enough for http -> https plus a moved path. */
export const MAX_REDIRECT_HOPS = 5;

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

export interface SafeFetchOptions {
  /** Response-size cap in bytes, on the decompressed body. Default {@link DEFAULT_MAX_RESPONSE_BYTES}. */
  maxBytes?: number;
  /** Total deadline for the exchange, body included. Default {@link DEFAULT_OUTBOUND_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * How many redirects to follow, each re-gated. Default 0: a 3xx is an
   * error. At most {@link MAX_REDIRECT_HOPS}.
   */
  maxRedirects?: number;
  /**
   * The one host an explicit private-URL opt-in lets resolve privately,
   * matched exactly. Only ever set from an env flag or an org allowlist.
   */
  privateHost?: string | null;
}

export type SafeFetchInit = Omit<RequestInit, 'redirect'> & SafeFetchOptions;

function hostOf(url: string): string {
  return stripBrackets(new URL(url).hostname.toLowerCase());
}

/** The string gate for one hop: strict, or relaxed for the one opted-in host. */
function gateHop(url: string, privateHost: string | null): string {
  let host: string;
  try {
    host = hostOf(url);
  } catch {
    throw new EgressError(`Refused to request ${url}: not a URL`);
  }
  const validation =
    privateHost && host === privateHost ? validateUrlAllowingPrivate(url) : validateUrl(url);
  if (!validation.valid) {
    throw new EgressError(validation.error ?? `Refused to request ${url}`);
  }
  return validation.sanitizedUrl!;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * The same response, with its body capped at `maxBytes`.
 *
 * A declared `content-length` over the cap is refused before a byte is
 * read. Otherwise the body is counted as it streams (after decompression,
 * so a small gzip bomb is counted at its real size) and the stream errors
 * with `ResponseTooLargeError` the moment it passes the cap, which also
 * cancels the upstream read.
 */
export function capResponse(res: Response, maxBytes: number): Response {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body || typeof (res.body as any).pipeThrough !== 'function' || NULL_BODY_STATUSES.has(res.status)) {
    return res;
  }
  let seen = 0;
  const capped = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) controller.error(new ResponseTooLargeError(maxBytes));
        else controller.enqueue(chunk);
      },
    }),
  );
  const out = new Response(capped, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, 'url', { value: res.url });
  return out;
}

/** A body read that stops at `maxBytes` instead of buffering whatever the other end sends. */
export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  return capResponse(res, maxBytes).text();
}

/** Headers that must not follow a redirect to a different origin. */
const ORIGIN_BOUND_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

function withoutOriginBoundHeaders(headers: HeadersInit | undefined): Headers {
  const out = new Headers(headers);
  for (const name of ORIGIN_BOUND_HEADERS) out.delete(name);
  return out;
}

/**
 * `fetch`, gated. The same call shape, plus the options above.
 *
 * Throws `EgressError` for a refused URL or redirect hop and
 * `ResponseTooLargeError` for a declared oversize body; a body that grows
 * past the cap rejects the later `.text()` / `.json()` with it. Transport
 * failures (including the pin refusing an address) surface as fetch's own
 * `TypeError`: pass them through `outboundFailureDetail` before showing
 * them to anybody.
 */
export async function safeFetch(urlString: string, init: SafeFetchInit = {}): Promise<Response> {
  const {
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS,
    maxRedirects = 0,
    privateHost: rawPrivateHost,
    ...rest
  } = init;
  const privateHost = rawPrivateHost ? stripBrackets(rawPrivateHost.toLowerCase()) : null;
  const hops = Math.max(0, Math.min(maxRedirects, MAX_REDIRECT_HOPS));

  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = rest.signal ? AbortSignal.any([rest.signal, deadline]) : deadline;
  const dispatcher = privateHost ? dispatcherExempting(privateHost) : ssrfSafeDispatcher;

  let current = gateHop(urlString, privateHost);
  let method = rest.method;
  let body = rest.body;
  let headers: HeadersInit | undefined = rest.headers;

  for (let hop = 0; ; hop++) {
    const res = await fetch(current, {
      ...rest,
      method,
      body,
      headers,
      signal,
      redirect: hops > 0 ? 'manual' : 'error',
      dispatcher,
    } as RequestInit);

    const location = hops > 0 && res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return capResponse(res, maxBytes);

    await res.body?.cancel().catch(() => undefined);
    if (hop >= hops) throw new EgressError(`Refused to follow more than ${hops} redirects`);

    let next: string;
    try {
      next = gateHop(new URL(location, current).toString(), privateHost);
    } catch (err) {
      throw new EgressError(
        `Refused to follow a redirect: ${err instanceof Error ? err.message : 'the target is not allowed'}`,
      );
    }
    if (new URL(next).origin !== new URL(current).origin) headers = withoutOriginBoundHeaders(headers);
    // 303 always, and 301/302 after a POST, continue as a GET (as browsers do).
    const upper = (method ?? 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && upper === 'POST')) {
      method = upper === 'HEAD' ? 'HEAD' : 'GET';
      body = undefined;
    }
    current = next;
  }
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
