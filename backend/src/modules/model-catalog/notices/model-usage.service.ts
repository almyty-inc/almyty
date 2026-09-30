import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Agent } from '../../../entities/agent.entity';
import { AgentRole } from '../../../entities/agent-role.entity';
import { Model } from '../../../entities/model.entity';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { canRead } from '../../../common/authorization/read-rule';
import { collectModelReferences, collectProviderReferences } from '../../agents/agent-references';

/** Agents named to a person: the ones they may read, and how many others. */
export interface AgentsForViewer {
  agents: Array<{ id: string; name: string }>;
  /** Agents the viewer may not read, counted and never named. */
  others: number;
}

/**
 * Which agents use a provider connection, and which of its models.
 *
 * An agent uses a model when it names the connection and the model id
 * (its model, a role, a step, a checker, its team; collectModelReferences)
 * or when one of its roles is pinned to that model's card. It uses the
 * connection when it names it at all, with or without a model.
 *
 * Read when a model goes away (who to tell), when a model is about to be
 * turned off on the connection (refused while an agent uses it), and when
 * the connection is about to be removed (the confirmation names them).
 */
@Injectable()
export class ModelUsageService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(AgentRole) private readonly agentRoles: Repository<AgentRole>,
    @InjectRepository(Model) private readonly models: Repository<Model>,
    @Optional() private readonly accessPolicy?: AccessPolicyService,
  ) {}

  /** For each vendor model id of this connection an agent uses, the agents that use it. */
  async modelsInUse(organizationId: string, providerId: string): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const add = (model: string, agentId: string) => {
      const list = out.get(model) ?? [];
      if (!list.includes(agentId)) list.push(agentId);
      out.set(model, list);
    };
    for (const agent of await this.liveAgents(organizationId)) {
      for (const ref of collectModelReferences(agent)) {
        if (ref.providerId === providerId) add(ref.model, agent.id);
      }
    }
    for (const [agentId, card] of await this.pinnedRoleCards(organizationId)) {
      if (card.providerId === providerId) add(card.vendorModelId, agentId);
    }
    return out;
  }

  /** Every agent that names this connection, with or without a model. */
  async agentsUsingConnection(organizationId: string, providerId: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const agent of await this.liveAgents(organizationId)) {
      if (collectProviderReferences(agent).has(providerId)) ids.add(agent.id);
    }
    for (const [agentId, card] of await this.pinnedRoleCards(organizationId)) {
      if (card.providerId === providerId) ids.add(agentId);
    }
    return [...ids];
  }

  /** The agents a person may read by name, the rest as a count. */
  async forViewer(organizationId: string, agentIds: string[], viewerId: string | null | undefined): Promise<AgentsForViewer> {
    if (agentIds.length === 0) return { agents: [], others: 0 };
    const rows = await this.agents.find({
      where: { organizationId, id: In(agentIds) },
      select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true },
    });
    const agents: AgentsForViewer['agents'] = [];
    let others = 0;
    for (const row of rows) {
      const readable = this.accessPolicy ? await canRead(this.accessPolicy, viewerId ? { id: viewerId } : undefined, row) : (row.visibility ?? 'org') === 'org';
      if (readable) agents.push({ id: row.id, name: row.name });
      else others++;
    }
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return { agents, others };
  }

  /** "Support triage", "Support triage and Billing bot", "Support triage and 2 other agents". */
  static describe(who: AgentsForViewer): string {
    const names = who.agents.map((a) => a.name);
    if (who.others > 0) names.push(who.others === 1 ? '1 other agent' : `${who.others} other agents`);
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  private liveAgents(organizationId: string): Promise<Agent[]> {
    return this.agents.find({
      where: { organizationId, isTemporary: false },
      select: { id: true, modelConfig: true, pipeline: true, agentConfig: true, collaboration: true, models: true },
    });
  }

  /** Roles pinned to a model card (agent_roles), with the card. */
  private async pinnedRoleCards(organizationId: string): Promise<Array<[string, Model]>> {
    const roles = await this.agentRoles.find({ where: { organizationId } });
    const pinned = roles
      .map((r) => ({ agentId: r.agentId, modelId: (r.binding as { mode?: string; modelId?: string } | null)?.mode === 'pinned' ? (r.binding as { modelId?: string }).modelId : undefined }))
      .filter((r): r is { agentId: string; modelId: string } => !!r.modelId);
    if (pinned.length === 0) return [];
    const cards = await this.models.find({ where: { organizationId, id: In([...new Set(pinned.map((p) => p.modelId))]) } });
    const byId = new Map(cards.map((c) => [c.id, c]));
    return pinned.filter((p) => byId.has(p.modelId)).map((p) => [p.agentId, byId.get(p.modelId)!]);
  }
}
