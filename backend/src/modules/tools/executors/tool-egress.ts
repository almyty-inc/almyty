import type { AxiosRequestConfig } from 'axios';
import type { Repository } from 'typeorm';

import { Organization } from '../../../entities/organization.entity';
import { agentsExempting, ssrfSafeHttpAgent, ssrfSafeHttpsAgent } from '../../../common/security/ssrf-safe-agent';
import { validateUrl } from '../../../common/security/url-validator';
import { decideEgress } from '../../connections/egress-policy';

export interface ToolEgress {
  /** Why the call may not go out; null when it may. */
  error: string | null;
  httpAgent?: AxiosRequestConfig['httpAgent'];
  httpsAgent?: AxiosRequestConfig['httpsAgent'];
  /**
   * Set when the host is reached only because the organization put it on
   * its egress allowlist: the one name the pinning lookup may resolve to a
   * private address. A caller that dials outside axios (gRPC) passes it on.
   */
  exemptHost?: string;
}

/**
 * May a tool call go to `url`, and through which agents?
 *
 * A public URL passes `validateUrl` and goes through the DNS-pinning
 * agents. A private, loopback or link-local one is refused unless its
 * host is on the organization's egress allowlist (settings
 * .egressAllowlist), the same allowlist a model provider's URL is judged
 * by: an API on the organization's own network is reachable once an
 * admin says that host is theirs. Then the pinning lookup makes an
 * exception for that one name and nothing else. Every tool executor that
 * makes an outbound call (HTTP, GraphQL, SOAP, gRPC) decides here, so a
 * host is reachable by all of them or by none. See
 * connections/egress-policy.ts and docs/connections.md.
 */
export async function decideToolEgress(
  url: string,
  organizationId: string | null | undefined,
  organizations: Repository<Organization> | undefined,
): Promise<ToolEgress> {
  const strict = validateUrl(url);
  if (strict.valid) return { error: null, httpAgent: ssrfSafeHttpAgent, httpsAgent: ssrfSafeHttpsAgent };
  const refused = { error: strict.error ?? 'The URL is not allowed' };
  if (!organizationId || !organizations) return refused;
  const organization = await organizations.findOne({ where: { id: organizationId } });
  const decision = decideEgress(url, { allowlist: organization?.settings?.egressAllowlist ?? [] });
  if (!decision.allowed || !decision.viaAllowlist) return refused;
  const host = new URL(url).hostname;
  return { error: null, ...agentsExempting(host), exemptHost: host };
}
