import { validateUrl, validateUrlAllowingPrivate } from '../../common/security/url-validator';

/**
 * Where an organization is allowed to send a request it supplied the URL for.
 *
 * This is L1's job rather than L2's. Every generic provider takes a
 * user-supplied base URL, so the gate has to sit under all of them rather
 * than being re-implemented per consumer. See docs/design/layers.md, L1.
 *
 * Called from the provider save path in `llm-providers.service`, which is
 * where a user-supplied URL enters the system: one check there covers
 * every later request rather than being re-argued per call site.
 *
 * Reaching a private host used to be two environment flags,
 * `OLLAMA_ALLOW_PRIVATE_URLS` and `LLM_ALLOW_PRIVATE_URLS`. Those are
 * install-wide: switching one on to let one team reach one internal
 * endpoint opens every private range to every organization on the
 * install. An allowlist of hosts, per organization, says the same thing
 * without that blast radius. The flags still work where they always did.
 *
 * This is the static gate, and it only judges what a string can be known
 * by. A hostname is not known to be private until it resolves, so a name
 * pointing at an internal address is caught at request time by the
 * DNS-pinning agent in `ssrf-safe-agent.ts` instead. The two are
 * complementary and neither replaces the other. An allowlisted hostname
 * survives the connect-time check because the save path records that one
 * host on the provider and the agent exempts exactly it; see
 * `agentsExempting` and docs/connections.md.
 *
 * The rule: a public URL is allowed if it passes the SSRF validator. A
 * private, loopback or link-local URL is refused unless its host is on
 * the organization's allowlist, and then only that host.
 */
export interface EgressDecision {
  allowed: boolean;
  /** Why it was refused, phrased for the person who typed the URL. */
  reason?: string;
  /** Set when the host was reached only because it is allowlisted. */
  viaAllowlist?: boolean;
}

export interface EgressPolicy {
  /** Hostnames an organization may reach even though they are private. */
  allowlist?: string[];
}

/** Hosts are compared case-insensitively, and a leading `*.` matches one label or more. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".internal.example"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

/**
 * Decide whether a user-supplied URL may be called on behalf of an org.
 *
 * `validateUrl` already refuses non-HTTP schemes, credentials in the URL,
 * and private ranges. `validateUrlAllowingPrivate` refuses everything
 * except the private ranges, so the allowlist path still gets the rest of
 * the checks rather than becoming a hole.
 */
export function decideEgress(urlString: string, policy: EgressPolicy = {}): EgressDecision {
  const strict = validateUrl(urlString);
  if (strict.valid) return { allowed: true };

  let host: string;
  try {
    host = new URL(urlString).hostname;
  } catch {
    return { allowed: false, reason: strict.error ?? 'not a valid URL' };
  }

  const allowlisted = (policy.allowlist ?? []).some((pattern) => hostMatches(host, pattern));
  if (!allowlisted) {
    return {
      allowed: false,
      reason:
        `${host} is not reachable: it resolves to a private or loopback address. ` +
        'Add it to this organization\'s egress allowlist if the endpoint really is on your network.',
    };
  }

  // Allowlisted, but it still has to be an otherwise sane URL.
  const relaxed = validateUrlAllowingPrivate(urlString);
  if (!relaxed.valid) return { allowed: false, reason: relaxed.error ?? 'not a valid URL' };
  return { allowed: true, viaAllowlist: true };
}

export class EgressNotAllowedError extends Error {
  readonly code = 'EGRESS_NOT_ALLOWED';
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'EgressNotAllowedError';
  }
}

/** Throw unless the URL may be called. */
export function assertEgressAllowed(urlString: string, policy: EgressPolicy = {}): void {
  const decision = decideEgress(urlString, policy);
  if (!decision.allowed) throw new EgressNotAllowedError(urlString, decision.reason ?? 'refused');
}
