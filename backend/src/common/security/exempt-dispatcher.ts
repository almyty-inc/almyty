/**
 * The undici counterpart to `agentsExempting(host)`.
 *
 * A private-URL escape hatch (MCP_ALLOW_PRIVATE_URLS, a connector's
 * `privateUrlsEnv`) relaxes the string gate so a self-hoster can reach a
 * server on their own network. The pinned dispatcher would still refuse
 * that server's NAME at connect time, and the tempting fix (drop the
 * dispatcher) turns the hatch into "no DNS pinning for anything this
 * request touches".
 *
 * This keeps the exception to the one host the request is for, matched
 * exactly; any other name resolved through the dispatcher is checked as
 * strictly as `ssrfSafeDispatcher` checks it. Callers still refuse
 * redirects, so in practice the request never reaches another host.
 *
 * The cache is bounded because the host comes from tenant-written
 * configuration: an unbounded map of connection pools keyed by it would
 * be a slow leak.
 */
import * as dns from 'dns';
import { Agent } from 'undici';

import { pinnedLookup } from './ssrf-safe-agent';

const MAX_EXEMPT_DISPATCHERS = 64;
const exemptDispatchers = new Map<string, Agent>();

export function dispatcherExempting(host: string): Agent {
  const key = host.toLowerCase();
  const existing = exemptDispatchers.get(key);
  if (existing) return existing;

  const lookup = (hostname: string, options: any, callback?: any): void => {
    if (hostname.toLowerCase() !== key) {
      pinnedLookup(hostname, options, callback);
      return;
    }
    const cb = typeof options === 'function' ? options : callback;
    const opts = options && typeof options === 'object' ? options : {};
    const plainLookup: any = dns.lookup;
    plainLookup(hostname, opts, cb);
  };

  if (exemptDispatchers.size >= MAX_EXEMPT_DISPATCHERS) {
    const oldest = exemptDispatchers.keys().next().value as string;
    const evicted = exemptDispatchers.get(oldest);
    exemptDispatchers.delete(oldest);
    // close() lets in-flight requests finish before the pool goes away.
    evicted?.close().catch(() => undefined);
  }

  const dispatcher = new Agent({ connect: { lookup: lookup as any } });
  exemptDispatchers.set(key, dispatcher);
  return dispatcher;
}
