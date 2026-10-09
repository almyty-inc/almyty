import { Controller, Get, HttpException, HttpStatus, Injectable, Param, ParseUUIDPipe, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { PrivateAgentByAgentIdGuard } from '../../common/authorization/private-resource.guard';
import { Agent } from '../../entities/agent.entity';
import { Api } from '../../entities/api.entity';
import { ConnectionGrant } from '../../entities/connection-grant.entity';
import { Credential } from '../../entities/credential.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Tool } from '../../entities/tool.entity';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AgentsService } from './agents.service';

/**
 * What an agent would no longer reach if it acted as itself
 * (agentConfig.runAs = 'agent'; agent-identity.ts).
 *
 * Acting as itself, an agent uses organization model providers only, and a
 * connection only once it is granted to the agent. This lists what the
 * agent's own settings point at that fails that test -- its models'
 * providers and their keys, its memory account, the connections of the APIs
 * it uses -- so the page can say so, and offer to grant the ones a grant
 * can open. Nothing here grants anything: a grant is the person's click,
 * through the existing grants API.
 */
export type ReachScope = 'private' | 'personal' | 'team' | 'organization';

export interface ReachItem {
  kind: 'provider' | 'connection';
  id: string;
  name: string;
  /** What the agent needs it for, in words ("Its model", "Its memory", "The API Payments"). */
  neededFor: string;
  scope: ReachScope;
  /** True when a grant to the agent would let it use this. */
  canGrant: boolean;
  /** Why it cannot be granted, in words; set when canGrant is false. */
  note?: string;
}

const NO_PRIVATE_PROVIDER =
  'A private model provider cannot be shared with an agent. Use a provider shared with the organization for this agent.';
const NO_TEAM_PROVIDER =
  "An agent that acts as itself does not use a team's model providers. Use a provider shared with the organization.";
const NO_PRIVATE_CONNECTION =
  'A private connection cannot be shared. Connect it again as a personal or organization connection to give it to the agent.';
const NO_TEAM_CONNECTION =
  "An agent that acts as itself does not use a team's connections. Use a personal or organization connection.";

function scopeOf(row: { visibility?: string | null; ownerUserId?: string | null }): ReachScope {
  if (row.visibility === 'private') return 'private';
  if (row.visibility === 'team') return 'team';
  return row.ownerUserId ? 'personal' : 'organization';
}

/** The model providers an agent's settings name: its main model, every role, every verifier. */
export function providerIdsOf(agent: Pick<Agent, 'modelConfig' | 'models' | 'agentConfig'>): string[] {
  const ids = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string' && id.trim()) ids.add(id);
  };
  add(agent.modelConfig?.providerId);
  for (const role of agent.models?.roles ?? []) if (role.kind !== 'agent') add(role.providerId);
  for (const checker of agent.agentConfig?.verify?.checkers ?? []) add(checker.providerId);
  return [...ids];
}

@Injectable()
export class AgentIdentityReachService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    @InjectRepository(Tool) private readonly tools: Repository<Tool>,
  ) {}

  /** What `agent` could not reach acting as itself, as its settings stand. */
  async unreachable(agent: Agent): Promise<ReachItem[]> {
    const organizationId = agent.organizationId;
    const items: ReachItem[] = [];
    const needed = new Map<string, string>();

    const providerIds = providerIdsOf(agent);
    const providers = providerIds.length
      ? await this.providers.find({ where: { id: In(providerIds), organizationId } })
      : [];
    for (const p of providers) {
      const scope = scopeOf(p);
      if (scope === 'private' || scope === 'team') {
        items.push({
          kind: 'provider',
          id: p.id,
          name: p.name,
          neededFor: 'Its model',
          scope,
          canGrant: false,
          note: scope === 'private' ? NO_PRIVATE_PROVIDER : NO_TEAM_PROVIDER,
        });
      }
      if (p.credentialId && !needed.has(p.credentialId)) needed.set(p.credentialId, `The key for its model (${p.name})`);
    }

    const memoryCredential = agent.memoryConfig?.credentialId;
    if (memoryCredential && !needed.has(memoryCredential)) needed.set(memoryCredential, 'Its memory');

    const toolApiIds = agent.toolIds?.length
      ? (await this.tools.find({ where: { id: In(agent.toolIds), organizationId }, select: { id: true, apiId: true } as any }))
          .map((t) => t.apiId)
          .filter((id): id is string => !!id)
      : [];
    const apiIds = [...new Set([...(agent.agentConfig?.apiIds ?? []), ...toolApiIds])];
    // An API's key can also be a connection it points at (picked on its Key
    // card, rather than bound to the API): that one is needed as much.
    if (apiIds.length) {
      const apis = await this.agents.manager
        .getRepository(Api)
        .find({ where: { id: In(apiIds), organizationId }, select: { id: true, name: true, authentication: true } as any });
      for (const api of apis) {
        const connectionId = (api.authentication as any)?.config?.connectionId;
        if (typeof connectionId === 'string' && connectionId && !needed.has(connectionId)) needed.set(connectionId, `The key for ${api.name}`);
      }
    }

    const credentials = this.agents.manager.getRepository(Credential);
    const rows: Credential[] = [];
    if (needed.size) rows.push(...(await credentials.find({ where: { id: In([...needed.keys()]), organizationId } })));
    if (apiIds.length) {
      for (const row of await credentials.find({ where: { apiId: In(apiIds), organizationId } })) {
        if (!rows.some((r) => r.id === row.id)) {
          rows.push(row);
          needed.set(row.id, 'An API it uses');
        }
      }
    }

    const connectionIds = rows.filter((r) => r.connectorKey).map((r) => r.id);
    const granted = new Set(
      connectionIds.length
        ? (
            await this.agents.manager.getRepository(ConnectionGrant).find({
              where: { connectionId: In(connectionIds), principalType: 'agent', principalId: agent.id },
            })
          )
            .filter((g) => !g.expiresAt || g.expiresAt.getTime() > Date.now())
            .map((g) => g.connectionId)
        : [],
    );

    for (const row of rows) {
      // A provider's own pasted key follows its provider, listed above.
      if ((row.metadata as Record<string, any> | null)?.managedBy) continue;
      const scope = scopeOf(row);
      const base = { kind: 'connection' as const, id: row.id, name: row.name, neededFor: needed.get(row.id) ?? 'Its settings', scope };
      if (scope === 'private') {
        items.push({ ...base, canGrant: false, note: NO_PRIVATE_CONNECTION });
      } else if (scope === 'team') {
        items.push({ ...base, canGrant: false, note: NO_TEAM_CONNECTION });
      } else if (row.connectorKey && !granted.has(row.id)) {
        // Plain organization credentials are not connections and need no grant.
        items.push({ ...base, canGrant: true });
      }
    }
    return items;
  }
}

@ApiTags('Agents')
@ApiBearerAuth()
@Controller('agents/:agentId/identity')
@UseGuards(JwtAuthGuard, RolesGuard, PrivateAgentByAgentIdGuard)
export class AgentIdentityReachController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly reach: AgentIdentityReachService,
  ) {}

  @Get('unreachable')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'What this agent would not reach if it acted as itself' })
  async unreachable(@Request() req: any, @Param('agentId', ParseUUIDPipe) agentId: string) {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    const agent = await this.agentsService.getAgent(agentId, organizationId, { id: req.user.id });
    return { success: true, data: await this.reach.unreachable(agent) };
  }
}
