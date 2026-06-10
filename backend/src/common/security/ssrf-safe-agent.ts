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
 * then re-validates every returned address through `validateUrl` (which
 * carries the full private/loopback/link-local/metadata/ULA/mapped-IPv6
 * ban list). If any resolved address is banned, the connection is
 * refused before a socket is opened. This mirrors what the sandbox
 * net-guard does for tool code, but for the host-side executors.
 *
 * Use by attaching to an axios request: `{ httpAgent, httpsAgent }`.
 * `maxRedirects: 0` is still required on the request itself — the agent
 * pins DNS, the request config refuses cross-host 3xx.
 */
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import * as dns from 'dns';
import { validateUrl } from './url-validator';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

export function isAddressBanned(address: string, family?: number): boolean {
  // Reuse the full IP ban list in validateUrl by handing it a URL whose
  // host is the resolved IP. IPv6 must be bracketed.
  const host = family === 6 ? `[${address}]` : address;
  return !validateUrl(`http://${host}`).valid;
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

  (dns.lookup as any)(hostname, opts, (err: NodeJS.ErrnoException | null, address: any, family?: number) => {
    if (err) return cb(err, address, family);

    const addrs: dns.LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address, family: family as number }];

    for (const a of addrs) {
      if (isAddressBanned(a.address, a.family)) {
        return cb(
          Object.assign(
            new Error(`SSRF blocked: ${hostname} resolved to disallowed address ${a.address}`),
            { code: 'ERR_SSRF_BLOCKED' },
          ),
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
