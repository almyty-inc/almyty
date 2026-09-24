/**
 * SSRF-safe HTTP/HTTPS agents with DNS pinning.
 *
 * `validateUrl()` only inspects the hostname string. For a literal IP
 * that's enough, but a hostname is resolved by the HTTP client at
 * connect time — so an attacker can register a public name whose A
 * record points at `169.254.169.254` / `127.0.0.1` (DNS rebinding) and
 * sail past the up-front string check.
 *
 * These agents install a custom `lookup` that resolves the hostname and
 * then classifies every returned address with `classifyAddress` from
 * `ip-classification.ts` — the same function `validateUrl` and the sandbox
 * net guard use, so an IPv6 answer that embeds a banned IPv4 address
 * (mapped, NAT64, 6to4, ...) is refused exactly as the IPv4 would be. If
 * any resolved address is banned, the connection is refused before a
 * socket is opened. This mirrors what the sandbox net-guard does for tool
 * code, but for the host-side executors.
 *
 * Use by attaching to an axios request: `{ httpAgent, httpsAgent }`.
 * `maxRedirects: 0` is still required on the request itself — the agent
 * pins DNS, the request config refuses cross-host 3xx.
 */
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import * as dns from 'dns';
import { classifyAddress, isBlockedHostname } from './ip-classification';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * Is a resolved address one the server must not connect to? Anything that
 * is not a public IP literal is refused: a resolver answer that does not
 * even parse as an address is not something to hand to connect().
 */
export function isAddressBanned(address: string, _family?: number): boolean {
  return classifyAddress(address).kind !== 'public';
}

function ssrfBlocked(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'ERR_SSRF_BLOCKED' });
}

/**
 * A drop-in replacement for `dns.lookup` that refuses to resolve to a
 * banned address. Handles both the `(hostname, callback)` and
 * `(hostname, options, callback)` call forms, and both the single-address
 * and `{ all: true }` result shapes.
 */
export function pinnedLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | LookupCallback | number,
  callback?: LookupCallback,
): void {
  const cb: LookupCallback =
    typeof options === 'function' ? (options as LookupCallback) : (callback as LookupCallback);
  const opts = typeof options === 'function' || typeof options === 'number' ? {} : options;

  // Metadata and cluster names are refused before DNS is asked at all.
  if (isBlockedHostname(hostname)) {
    process.nextTick(() => cb(ssrfBlocked(`SSRF blocked: ${hostname} is a blocked hostname`), '', undefined));
    return;
  }

  (dns.lookup as any)(hostname, opts, (err: NodeJS.ErrnoException | null, address: any, family?: number) => {
    if (err) return cb(err, address, family);

    const addrs: dns.LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address, family: family as number }];

    for (const a of addrs) {
      if (isAddressBanned(a.address, a.family)) {
        return cb(
          ssrfBlocked(`SSRF blocked: ${hostname} resolved to disallowed address ${a.address}`),
          address,
          family,
        );
      }
    }

    cb(null, address, family);
  });
}

export const ssrfSafeHttpAgent = new HttpAgent({ lookup: pinnedLookup as any });
export const ssrfSafeHttpsAgent = new HttpsAgent({ lookup: pinnedLookup as any });

/**
 * Agents that make one exception, for one host.
 *
 * An organization can allowlist a host it owns on a private network. The
 * URL-string gate can act on that when the host is an address, but a NAME
 * is not knowably private until it resolves, so without this the pinning
 * lookup refuses the very name the organization just vouched for.
 *
 * The exception is deliberately as narrow as it can be: it applies to one
 * hostname, matched exactly, and every other name resolved through these
 * agents is checked as strictly as before. That matters because a pool is
 * shared across requests — an exception any wider would leak to hosts
 * nobody approved.
 */
const exemptAgents = new Map<string, { httpAgent: HttpAgent; httpsAgent: HttpsAgent }>();

export function agentsExempting(host: string): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  const key = host.toLowerCase();
  const existing = exemptAgents.get(key);
  if (existing) return existing;

  const lookup = (hostname: string, options: any, callback?: any): void => {
    if (hostname.toLowerCase() === key) {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'function' || typeof options === 'number' ? {} : options;
      return (dns.lookup as any)(hostname, opts, cb);
    }
    return pinnedLookup(hostname, options, callback);
  };

  const agents = {
    httpAgent: new HttpAgent({ lookup: lookup as any }),
    httpsAgent: new HttpsAgent({ lookup: lookup as any }),
  };
  exemptAgents.set(key, agents);
  return agents;
}
