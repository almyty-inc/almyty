/**
 * Every request this server makes to Hugging Face, redirects included.
 *
 * The Hub answers a file read with a redirect to its CDN (cdn-lfs,
 * cas-bridge.xethub, ...), so these fetches have to follow one. They used
 * to follow anything, with global `fetch`'s default: no hop limit, no
 * host check, no address check, and the HF token riding along. A Location
 * pointing at 169.254.169.254 or an internal service would have been
 * requested from inside the network.
 *
 * Here each hop is taken by hand (`redirect: 'manual'`) and must:
 *  - be https, on a Hugging Face host (huggingface.co, hf.co, or one of
 *    their subdomains);
 *  - pass the shared SSRF string gate (url-validator, which classifies a
 *    literal address through common/security/ip-classification.ts);
 *  - connect through `ssrfSafeDispatcher`, so a name resolving to a
 *    private address is refused at connect;
 * and the chain stops after HF_MAX_REDIRECTS. The Authorization header
 * goes to huggingface.co only, never to a CDN host.
 */
import { EgressError, assertOutboundUrlAllowed, ssrfSafeDispatcher } from '../../common/security/safe-fetch';

/** The Hub's redirect chain is one or two hops; anything longer is not the Hub. */
export const HF_MAX_REDIRECTS = 5;

const HF_DOMAINS = ['huggingface.co', 'hf.co'];

/** The host a token is sent to. */
const HF_API_HOST = 'huggingface.co';

/** Whether `hostname` is Hugging Face's own: the apex or a subdomain of it. */
export function isHuggingFaceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return HF_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export interface HfFetchInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** The fetch the hops go through; the global one outside tests. */
export type HfFetchTransport = (url: string, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

function refuse(message: string): never {
  throw new EgressError(message);
}

function withoutAuthorization(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') out[key] = value;
  }
  return out;
}

/** GET a Hugging Face URL, following the Hub's redirects under the rules above. */
export async function hfFetch(
  url: string,
  init: HfFetchInit = {},
  // The pin and the redirect refusal are spelled out on the fetch itself
  // as well as on every hop below, so the transport cannot lose them.
  transport: HfFetchTransport = (target, options) =>
    fetch(target, { ...options, redirect: 'manual', dispatcher: ssrfSafeDispatcher } as RequestInit),
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      refuse(`Refused to fetch from Hugging Face: ${current} is not a URL`);
    }
    if (parsed.protocol !== 'https:') refuse(`Refused to fetch ${parsed.host} over ${parsed.protocol}: Hugging Face is https only`);
    if (!isHuggingFaceHost(parsed.hostname)) refuse(`Refused to fetch from ${parsed.hostname}: not a Hugging Face host`);
    const target = assertOutboundUrlAllowed(current);

    const headers = parsed.hostname.toLowerCase() === HF_API_HOST ? { ...(init.headers ?? {}) } : withoutAuthorization(init.headers ?? {});
    const res = await transport(target, {
      method: 'GET',
      headers,
      signal: init.signal,
      redirect: 'manual',
      dispatcher: ssrfSafeDispatcher,
    });

    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    if (hop >= HF_MAX_REDIRECTS) refuse(`Refused to follow more than ${HF_MAX_REDIRECTS} redirects from Hugging Face`);
    current = new URL(location, target).toString();
  }
}
