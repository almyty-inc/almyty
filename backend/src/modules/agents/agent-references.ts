import type { Agent, AgentPipeline } from '../../entities/agent.entity';
import type { AgentModels } from './autonomous-models';

/**
 * Every tool and agent an agent definition points at: `toolIds`, the
 * `tool_call` and `sub_agent` nodes of its pipeline, the tool list of its
 * `llm_call` nodes, the collaboration roster (members and judge) and its
 * autonomous agent roles. Used to decide whether the agent may reference
 * them (see assertAttachable) and who loses a tool or agent whose scope
 * narrows (see private-dependents).
 */
type LegacyCollaboration = { agents?: Array<{ agentId: string }>; judgeAgentId?: string };
type ParticipantLike = { kind?: string; agentId?: string } | null | undefined;

export function collectAgentReferences(agent: {
  toolIds?: string[] | null;
  pipeline?: AgentPipeline | null;
  collaboration?: Agent['collaboration'] | LegacyCollaboration | null;
  models?: Pick<AgentModels, 'roles'> | null;
}): { toolIds: Set<string>; agentIds: Set<string> } {
  const toolIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const id of agent.toolIds ?? []) if (typeof id === 'string' && id) toolIds.add(id);
  for (const node of agent.pipeline?.nodes ?? []) {
    const data: Record<string, any> = (node as any).data || (node as any).config || {};
    if (node.type === 'tool_call' && typeof data.toolId === 'string' && data.toolId) toolIds.add(data.toolId);
    // An llm_call step offers the model its own tool list.
    if (node.type === 'llm_call' && Array.isArray(data.toolIds)) {
      for (const id of data.toolIds) if (typeof id === 'string' && id) toolIds.add(id);
    }
    if (node.type === 'sub_agent' && typeof data.agentId === 'string' && data.agentId) agentIds.add(data.agentId);
  }
  // Collaboration members are `participants` (agents or models) plus an
  // optional `judge`; rows saved before that shape carry `agents` and
  // `judgeAgentId`. Only agent participants reference another agent.
  const collab = agent.collaboration as
    | ({ participants?: ParticipantLike[]; judge?: ParticipantLike } & LegacyCollaboration)
    | null
    | undefined;
  const addParticipant = (p: ParticipantLike) => {
    if (p && (p.kind === undefined || p.kind === 'agent') && typeof p.agentId === 'string' && p.agentId) {
      agentIds.add(p.agentId);
    }
  };
  for (const p of collab?.participants ?? []) addParticipant(p);
  addParticipant(collab?.judge);
  for (const member of collab?.agents ?? []) if (member?.agentId) agentIds.add(member.agentId);
  if (collab?.judgeAgentId) agentIds.add(collab.judgeAgentId);
  // Agent roles (panelists, teammates) of an autonomous agent's models.
  for (const role of agent.models?.roles ?? []) {
    if (role && role.kind === 'agent' && typeof role.agentId === 'string' && role.agentId) agentIds.add(role.agentId);
  }
  return { toolIds, agentIds };
}
/** One model an agent names by connection and model id, and where. */
export interface AgentModelReference {
  providerId: string;
  model: string;
  /** Where in the agent: "model", "step <label>", "role <name>", "checker", ... */
  where: string;
}

/**
 * Every (connection, model) pair an agent definition names: the same
 * places collectProviderReferences reads, keeping only those that name a
 * model. A reference with a connection and no model uses whatever the
 * connection defaults to, and a routed one names no model at all, so
 * neither is "using" a particular model. Roles bound in the agent_roles
 * table name a model card instead and are read by whoever needs them.
 */
export function collectModelReferences(agent: {
  modelConfig?: Agent['modelConfig'] | null;
  pipeline?: AgentPipeline | null;
  agentConfig?: Agent['agentConfig'] | null;
  collaboration?: Agent['collaboration'] | LegacyCollaboration | null;
  models?: Pick<AgentModels, 'roles'> | null;
}): AgentModelReference[] {
  const out: AgentModelReference[] = [];
  const add = (ref: { providerId?: unknown; model?: unknown } | null | undefined, where: string) => {
    const providerId = typeof ref?.providerId === 'string' ? ref.providerId.trim() : '';
    const model = typeof ref?.model === 'string' ? ref.model.trim() : '';
    if (providerId && model) out.push({ providerId, model, where });
  };
  const modelConfig = agent.modelConfig as { providerId?: string; model?: string; compaction?: { providerId?: string; model?: string } } | null | undefined;
  add(modelConfig, 'model');
  add(modelConfig?.compaction, 'context compaction');
  for (const node of agent.pipeline?.nodes ?? []) {
    const data: Record<string, any> = (node as any).data || (node as any).config || {};
    const label = typeof data.label === 'string' && data.label.trim() ? data.label.trim() : node.id;
    if (node.type === 'llm_call' || node.type === 'extract_context') add(data, `step ${label}`);
    if (node.type === 'verify' && Array.isArray(data.checkers)) {
      for (const checker of data.checkers) add(checker, `step ${label}`);
    }
  }
  const agentConfig = agent.agentConfig as { verify?: { checkers?: Array<{ providerId?: string; model?: string }> }; constraints?: { distill?: { providerId?: string; model?: string } } } | null | undefined;
  for (const checker of agentConfig?.verify?.checkers ?? []) add(checker, 'checker');
  add(agentConfig?.constraints?.distill, 'constraints');
  const collab = agent.collaboration as
    | { participants?: Array<{ kind?: string; providerId?: string; model?: string } | null>; judge?: { kind?: string; providerId?: string; model?: string } | null }
    | null
    | undefined;
  for (const p of [...(collab?.participants ?? []), collab?.judge]) {
    if (p && p.kind === 'model') add(p, 'team');
  }
  for (const role of agent.models?.roles ?? []) {
    if (role && role.kind === 'model') add(role, `role ${role.name || role.key}`);
  }
  return out;
}

/**
 * Every LLM provider an agent definition names directly: its own model
 * config and compaction model, the model nodes of its pipeline (`llm_call`,
 * `extract_context`, and each `verify` checker), the verify checkers in
 * `agentConfig`, and the model participants (and judge) of its
 * collaboration. Role- and routing-based references name no provider and
 * are resolved per caller at run time.
 */
export function collectProviderReferences(agent: {
  modelConfig?: Agent['modelConfig'] | { providerId?: string } | null;
  pipeline?: AgentPipeline | null;
  agentConfig?: Agent['agentConfig'] | null;
  collaboration?: Agent['collaboration'] | LegacyCollaboration | null;
  models?: Pick<AgentModels, 'roles'> | null;
}): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '') ids.add(value);
  };
  const modelConfig = agent.modelConfig as { providerId?: string; compaction?: { providerId?: string } } | null | undefined;
  add(modelConfig?.providerId);
  add(modelConfig?.compaction?.providerId);
  for (const node of agent.pipeline?.nodes ?? []) {
    const data: Record<string, any> = (node as any).data || (node as any).config || {};
    if (node.type === 'llm_call' || node.type === 'extract_context') add(data.providerId);
    if (node.type === 'verify' && Array.isArray(data.checkers)) {
      for (const checker of data.checkers) add(checker?.providerId);
    }
  }
  const verify = (agent.agentConfig as { verify?: { checkers?: Array<{ providerId?: string }> } } | null | undefined)?.verify;
  for (const checker of verify?.checkers ?? []) add(checker?.providerId);
  const collab = agent.collaboration as
    | { participants?: Array<{ kind?: string; providerId?: string } | null>; judge?: { kind?: string; providerId?: string } | null }
    | null
    | undefined;
  for (const p of [...(collab?.participants ?? []), collab?.judge]) {
    if (p && p.kind === 'model') add(p.providerId);
  }
  // The model roles of an autonomous agent's models.
  for (const role of agent.models?.roles ?? []) {
    if (role && role.kind === 'model') add(role.providerId);
  }
  return ids;
}
