/**
 * Enforcement for `gateway_tools.securityPolicy`.
 *
 * The column, the PATCH endpoint that writes it and the dashboard form
 * that fills it all existed before this file did; nothing in `backend/src`
 * ever read it. A user could set allowed domains, require-HTTPS and a max
 * response size on a gateway tool, watch it save, and have every one of
 * those settings ignored on the next call.
 *
 * This is the reader. It lives in `common/security` rather than in
 * `modules/gateways` because the enforcement point is the tool-execution
 * pipeline (`modules/tools/executors/*`), and an executor importing from
 * the gateways module would invert the dependency direction that
 * `url-validator.ts` and `ssrf-safe-agent.ts` already establish for
 * outbound-request gates.
 *
 * Relationship to the other outbound gates:
 *
 *   - `validateUrl()`     — install-wide SSRF floor. Never relaxed here.
 *   - `decideEgress()`    — per-organization private-host allowlist.
 *   - this file           — per-gateway-tool narrowing, set by the
 *                           organization for one tool on one gateway.
 *
 * All three only narrow. A policy can refuse a request the SSRF validator
 * would have allowed; it can never permit one the validator refused, which
 * is why every call site runs `validateUrl` first and this second.
 *
 * `securityPolicy` is null for the overwhelming majority of gateway tools.
 * A null or empty policy decides "allowed" for everything, so the wiring
 * changes nothing until an organization actually sets one.
 */

/** The shape stored in `gateway_tools.securityPolicy`. Mirrors `GatewayTool`. */
export interface GatewayToolSecurityPolicy {
  /** Only these domains may be called. Empty/absent means "no restriction". */
  allowedDomains?: string[];
  /** These domains may never be called, even if also allow-listed. */
  blockedDomains?: string[];
  /** Cap on the response body, in bytes. Narrows the executor default. */
  maxResponseSizeBytes?: number;
  /** Only these HTTP methods may be used. Empty/absent means "no restriction". */
  allowedHttpMethods?: string[];
  /** Refuse anything that is not https. */
  requireHttps?: boolean;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  /** Why it was refused, phrased for the person who wrote the policy. */
  reason?: string;
}

const ALLOWED: ToolPolicyDecision = { allowed: true };

/**
 * Does `host` fall under `pattern`?
 *
 * Exact match, or a subdomain of the pattern — the dashboard's own
 * placeholder for the blocked list is `internal.corp`, which a user
 * plainly intends to cover `admin.internal.corp` as well. `*.example.com`
 * is accepted for people who want to say "subdomains only" explicitly,
 * and then the apex does NOT match.
 *
 * Case-insensitive, and a trailing dot on the host (the root-label form
 * `example.com.`) is stripped so it cannot be used to slip past a block.
 */
export function domainMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.trim().toLowerCase().replace(/\.$/, '');
  if (!h || !p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p || h.endsWith(`.${p}`);
}

/**
 * May this gateway tool call `url` with `method`?
 *
 * Order matters: a blocked domain wins over an allowed one, so adding a
 * host to `blockedDomains` is always sufficient and never has to be
 * reconciled against what `allowedDomains` says.
 */
export function decideToolRequest(
  policy: GatewayToolSecurityPolicy | null | undefined,
  url: string,
  method?: string,
): ToolPolicyDecision {
  if (!policy) return ALLOWED;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Only reachable if a call site skipped validateUrl. Refusing is the
    // safe reading: a policy exists and we cannot tell whether it is met.
    return { allowed: false, reason: `not a valid URL: ${url}` };
  }

  const host = parsed.hostname;
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();

  if (policy.requireHttps && scheme !== 'https') {
    return {
      allowed: false,
      reason: `this tool's security policy requires HTTPS; the request targets ${scheme}://${host}`,
    };
  }

  const blocked = (policy.blockedDomains ?? []).filter(Boolean);
  if (blocked.some((pattern) => domainMatches(host, pattern))) {
    return {
      allowed: false,
      reason: `${host} is on this tool's blocked-domain list`,
    };
  }

  const allowed = (policy.allowedDomains ?? []).filter(Boolean);
  if (allowed.length > 0 && !allowed.some((pattern) => domainMatches(host, pattern))) {
    return {
      allowed: false,
      reason: `${host} is not on this tool's allowed-domain list`,
    };
  }

  const methods = (policy.allowedHttpMethods ?? [])
    .filter(Boolean)
    .map((m) => m.trim().toUpperCase());
  if (method && methods.length > 0 && !methods.includes(method.trim().toUpperCase())) {
    return {
      allowed: false,
      reason: `${method.toUpperCase()} is not an allowed method for this tool (allowed: ${methods.join(', ')})`,
    };
  }

  return ALLOWED;
}

/**
 * The response cap to hand axios, given the executor's own default.
 *
 * A policy may only tighten the install default, never raise it: a
 * per-tool setting of 1GB must not become a way around the 10MB ceiling
 * the executors were written with. Zero and negative values are ignored
 * rather than treated as "allow nothing", because the dashboard field is
 * a free-text number input and an empty-ish value means "unset".
 */
export function effectiveMaxResponseBytes(
  policy: GatewayToolSecurityPolicy | null | undefined,
  executorDefault: number,
): number {
  const configured = policy?.maxResponseSizeBytes;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return executorDefault;
  }
  return Math.min(configured, executorDefault);
}

export class ToolPolicyViolationError extends Error {
  readonly code = 'TOOL_POLICY_VIOLATION';
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(reason);
    this.name = 'ToolPolicyViolationError';
  }
}

/** Throw unless the gateway tool's policy permits this outbound request. */
export function assertToolRequestAllowed(
  policy: GatewayToolSecurityPolicy | null | undefined,
  url: string,
  method?: string,
): void {
  const decision = decideToolRequest(policy, url, method);
  if (!decision.allowed) {
    throw new ToolPolicyViolationError(url, decision.reason ?? 'refused by security policy');
  }
}
