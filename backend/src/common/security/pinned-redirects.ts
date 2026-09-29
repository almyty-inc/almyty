/**
 * Following a redirect without walking around the SSRF gate.
 *
 * Most call sites refuse redirects outright (`maxRedirects: 0` on axios,
 * `redirect: 'error'` on fetch), and that stays the default: a public
 * host that answers 302 with an internal `Location` is the standard way
 * around a string-only gate.
 *
 * A few fetches genuinely need to follow one -- a schema URL that 301s
 * from http to https, an agent card behind a moved path. For those,
 * `pinnedRedirects()` returns the axios config that:
 *
 *   - caps the chain at a small number of hops;
 *   - runs every hop's URL back through the string gate before the next
 *     request is made (`beforeRedirect` throws, follow-redirects turns the
 *     throw into a rejected request). The pinned agents do NOT cover this
 *     on their own: a literal address in `Location` (`http://127.0.0.1/`)
 *     never goes through a DNS lookup, so `pinnedLookup` never sees it;
 *   - keeps the DNS-pinning agents on every hop. axios hands
 *     follow-redirects a single `agent` for the first request's protocol,
 *     and an http -> https hop would otherwise carry the http agent into
 *     an https request (which Node refuses) -- so the hook swaps in the
 *     pinned agent that matches the next hop's protocol.
 */
import type { AxiosRequestConfig } from 'axios';
import type { Agent as HttpAgent } from 'http';
import type { Agent as HttpsAgent } from 'https';

import { EgressError } from './safe-fetch';
import { ssrfSafeHttpAgent, ssrfSafeHttpsAgent } from './ssrf-safe-agent';
import { UrlValidationResult, validateUrl } from './url-validator';

/** Enough for http -> https plus a moved path; a longer chain is not worth following. */
export const DEFAULT_REDIRECT_HOPS = 3;

export interface PinnedRedirectPolicy {
  /** Hop limit. Defaults to {@link DEFAULT_REDIRECT_HOPS}. */
  maxHops?: number;
  /** The pinned agents to use on every hop. Defaults to the shared SSRF-safe pair. */
  agents?: { httpAgent: HttpAgent; httpsAgent: HttpsAgent };
  /** The string gate each hop must pass. Defaults to `validateUrl`. */
  validate?: (url: string) => UrlValidationResult;
}

export type PinnedRedirectConfig = Required<
  Pick<AxiosRequestConfig, 'maxRedirects' | 'beforeRedirect' | 'httpAgent' | 'httpsAgent'>
>;

export function pinnedRedirects(policy: PinnedRedirectPolicy = {}): PinnedRedirectConfig {
  const httpAgent = policy.agents?.httpAgent ?? ssrfSafeHttpAgent;
  const httpsAgent = policy.agents?.httpsAgent ?? ssrfSafeHttpsAgent;
  const validate = policy.validate ?? validateUrl;

  return {
    maxRedirects: policy.maxHops ?? DEFAULT_REDIRECT_HOPS,
    httpAgent,
    httpsAgent,
    beforeRedirect: (options: Record<string, any>) => {
      const next = String(options.href ?? '');
      const check = validate(next);
      if (!check.valid) {
        throw new EgressError(`Refused to follow a redirect: ${check.error ?? 'the target is not allowed'}`);
      }
      options.agent = options.protocol === 'https:' ? httpsAgent : httpAgent;
    },
  };
}

export interface EgressAxiosOptions {
  /** Total deadline, body included. axios's own `timeout` is an idle timer that every byte resets. */
  timeoutMs?: number;
  /** axios's idle timer, for a slow upstream that should still fail fast when silent. Defaults to `timeoutMs`. */
  idleTimeoutMs?: number;
  /** Response-size cap (`maxContentLength`, counted after decompression). */
  maxBytes?: number;
  /** 0 (default) refuses every redirect; more follows that many, each re-gated. */
  maxRedirects?: number;
  /** The caller's own cancellation, combined with the deadline. */
  signal?: AbortSignal;
}

/**
 * The axios counterpart of `safeFetch`: every transport field a request to
 * a user-influenced URL needs, in one spread. The string gate still runs
 * first, at the call site (`assertOutboundUrlAllowed`), because the error
 * it throws is the caller's to phrase.
 *
 * Spread it LAST, so a caller's config cannot quietly switch the pin, the
 * redirect policy or the cap back off.
 */
export function egressAxiosConfig(options: EgressAxiosOptions = {}): Pick<
  AxiosRequestConfig,
  'maxRedirects' | 'beforeRedirect' | 'httpAgent' | 'httpsAgent' | 'maxContentLength' | 'timeout' | 'signal'
> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const redirects =
    (options.maxRedirects ?? 0) > 0
      ? pinnedRedirects({ maxHops: options.maxRedirects })
      : { maxRedirects: 0, httpAgent: ssrfSafeHttpAgent, httpsAgent: ssrfSafeHttpsAgent };
  return {
    ...redirects,
    maxContentLength: options.maxBytes ?? 10 * 1024 * 1024,
    timeout: Math.min(options.idleTimeoutMs ?? timeoutMs, timeoutMs),
    signal: signal as AxiosRequestConfig['signal'],
  };
}
