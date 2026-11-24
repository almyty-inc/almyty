import { Logger } from '@nestjs/common';
import type { FindOptionsSelect, Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentChannel } from '../../entities/agent-channel.entity';
import { Api } from '../../entities/api.entity';
import { ChannelInstallation } from '../../entities/channel-installation.entity';
import { Environment } from '../../entities/environment.entity';
import { ExternalAgent } from '../../entities/external-agent.entity';
import { Gateway } from '../../entities/gateway.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { McpSource } from '../../entities/mcp-source.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';
import { PushSubscription } from '../../entities/push-subscription.entity';
import { Tool } from '../../entities/tool.entity';
import type { ResourceLike } from '../../common/authorization/access-policy.service';

/**
 * What uses a credential, worked out when it is read from the rows that
 * point at it (docs/connections.md, "What points at the store"). Nothing
 * writes a list of users anywhere, so it cannot go stale: an API that
 * signs in with a Gmail connection is listed for as long as it does.
 *
 * A user the caller may not read (another member's private API, a team
 * agent outside their teams) is still counted, so deleting the credential
 * does not look harmless, but is not named.
 */
export interface CredentialUse {
  /** What kind of thing it is: api, tool, llm_provider, mcp_source, gateway, ... */
  type: string;
  /** Its id; null when the caller may not see it. */
  id: string | null;
  name: string;
  /** The agent a channel belongs to (its page is under the agent). */
  agentId?: string;
}

type RowRefs = (row: any) => Array<string | null | undefined>;

interface Source {
  entity: Function;
  type: string;
  /** Words for one the caller may not see. */
  hidden: string;
  /** Rows carry visibility/teamId/owner and are checked with the read rule. */
  scoped: boolean;
  select?: FindOptionsSelect<any>;
  relations?: Record<string, boolean>;
  refs: RowRefs;
  name: (row: any) => string;
  id?: (row: any) => string;
  agentId?: (row: any) => string | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const SOURCES: Source[] = [
  {
    entity: Tool,
    type: 'tool',
    hidden: 'A tool you cannot see',
    scoped: true,
    select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true, authConfig: true, npmRegistry: true },
    refs: (t: Tool) => [str(t.authConfig?.config?.credentialId), str(t.npmRegistry?.credentialId)],
    name: (t: Tool) => t.name,
  },
  {
    entity: LlmProvider,
    type: 'llm_provider',
    hidden: 'A model connection you cannot see',
    scoped: true,
    select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, ownerUserId: true, credentialId: true, usageCredentialId: true },
    refs: (p: LlmProvider) => [p.credentialId, p.usageCredentialId],
    name: (p: LlmProvider) => p.name,
  },
  {
    entity: McpSource,
    type: 'mcp_source',
    hidden: 'An MCP server',
    scoped: false,
    select: { id: true, name: true, organizationId: true, credentialId: true },
    refs: (s: McpSource) => [s.credentialId],
    name: (s: McpSource) => s.name,
  },
  {
    entity: Gateway,
    type: 'gateway',
    hidden: 'A gateway you cannot see',
    scoped: true,
    select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, ownerUserId: true, configuration: true, visitorOAuth: true, authConfigs: { id: true, configuration: true } },
    relations: { authConfigs: true },
    refs: (g: Gateway) => [
      str(g.configuration?.credentialId),
      str(g.visitorOAuth?.credentialId),
      ...(g.authConfigs ?? []).flatMap((a) => [str(a.configuration?.credentialId), str(a.configuration?.directoryCredentialId)]),
    ],
    name: (g: Gateway) => g.name,
  },
  {
    entity: ChannelInstallation,
    type: 'channel_installation',
    hidden: 'A channel installation',
    scoped: false,
    select: { id: true, organizationId: true, gatewayId: true, externalTenantId: true, credentialId: true },
    refs: (c: ChannelInstallation) => [c.credentialId],
    name: (c: ChannelInstallation) => `Channel installation ${c.externalTenantId}`,
    id: (c: ChannelInstallation) => c.gatewayId,
  },
  {
    entity: AgentChannel,
    type: 'agent_channel',
    hidden: 'A channel',
    scoped: false,
    select: { id: true, name: true, organizationId: true, agentId: true, configuration: true },
    refs: (c: AgentChannel) => [str(c.configuration?.credentialId), str(c.configuration?.signingCredentialId)],
    name: (c: AgentChannel) => c.name,
    agentId: (c: AgentChannel) => c.agentId,
  },
  {
    entity: Agent,
    type: 'agent',
    hidden: 'An agent you cannot see',
    scoped: true,
    select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true, memoryConfig: true },
    refs: (a: Agent) => [str(a.memoryConfig?.credentialId)],
    name: (a: Agent) => a.name,
  },
  {
    entity: ExternalAgent,
    type: 'external_agent',
    hidden: 'An outside agent',
    scoped: false,
    select: { id: true, name: true, organizationId: true, credentialId: true },
    refs: (e: ExternalAgent) => [e.credentialId],
    name: (e: ExternalAgent) => e.name,
  },
  {
    entity: Environment,
    type: 'environment',
    hidden: 'A hosted runner environment you cannot see',
    scoped: true,
    select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, ownerUserId: true, repo: true, envBindings: true, clusterConnectionId: true },
    refs: (e: Environment) => [str(e.repo?.connectionId), e.clusterConnectionId, ...(e.envBindings ?? []).map((b) => str(b?.connectionId))],
    name: (e: Environment) => e.name,
  },
  {
    entity: ModelDeployment,
    type: 'model_deployment',
    hidden: 'A hosted model',
    scoped: false,
    select: { id: true, organizationId: true, modelRef: true, providerType: true, providerConfig: true },
    refs: (d: ModelDeployment) => [str(d.providerConfig?.credentialId)],
    name: (d: ModelDeployment) => (d.modelRef ? `Hosted model ${d.modelRef}` : `Hosted model on ${d.providerType}`),
  },
  {
    entity: PushSubscription,
    type: 'push_subscription',
    hidden: 'A wake-up subscription',
    scoped: false,
    select: { id: true, name: true, organizationId: true, verifyCredentialId: true },
    refs: (s: PushSubscription) => [s.verifyCredentialId],
    name: (s: PushSubscription) => s.name,
  },
];

export interface UsageReader {
  getRepository(entity: Function): Pick<Repository<any>, 'find'>;
}

const logger = new Logger('CredentialUsage');

/**
 * Every credential's users, by credential id. `credentials` are rows of
 * one organization; `canRead` is the read rule for the caller.
 */
export async function credentialUses(
  reader: UsageReader,
  organizationId: string,
  credentials: Array<{ id: string; apiId?: string | null }>,
  canRead: (row: ResourceLike) => Promise<boolean>,
): Promise<Map<string, CredentialUse[]>> {
  const out = new Map<string, CredentialUse[]>(credentials.map((c) => [c.id, []]));
  if (credentials.length === 0) return out;

  // An API is bound to a credential from either side: the row's own
  // `apiId`, or the API naming it in its authentication.
  const boundTo = new Map<string, string[]>();
  for (const c of credentials) if (c.apiId) boundTo.set(c.apiId, [...(boundTo.get(c.apiId) ?? []), c.id]);
  const apiSource: Source = {
    entity: Api,
    type: 'api',
    hidden: 'An API you cannot see',
    scoped: true,
    select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, ownerUserId: true, authentication: true, npmRegistry: true },
    refs: (a: Api) => [
      str(a.authentication?.config?.credentialId),
      str(a.authentication?.config?.connectionId),
      str(a.npmRegistry?.credentialId),
      ...(boundTo.get(a.id) ?? []),
    ],
    name: (a: Api) => a.name,
  };

  for (const source of [apiSource, ...SOURCES]) {
    let rows: any[];
    try {
      rows = await reader.getRepository(source.entity).find({
        where: { organizationId },
        ...(source.select ? { select: source.select } : {}),
        ...(source.relations ? { relations: source.relations } : {}),
      });
    } catch (err: any) {
      // One table that cannot be read leaves the others' answer intact.
      logger.warn(`Could not read ${source.type} references: ${err?.message ?? err}`);
      continue;
    }
    for (const row of rows) {
      const hits = new Set(source.refs(row).filter((id): id is string => !!id && out.has(id)));
      if (hits.size === 0) continue;
      const visible = !source.scoped || (await canRead(row));
      const use: CredentialUse = visible
        ? { type: source.type, id: source.id ? source.id(row) : row.id, name: source.name(row) || source.hidden, ...(source.agentId ? { agentId: source.agentId(row) } : {}) }
        : { type: source.type, id: null, name: source.hidden };
      for (const id of hits) out.get(id)!.push(use);
    }
  }
  return out;
}
