import type { Agent, AgentPipeline } from '../../entities/agent.entity';

/**
 * Every tool and agent an agent definition points at: `toolIds`, the
 * `tool_call` and `sub_agent` nodes of its pipeline, and the
 * collaboration roster (members and judge). Used to decide whether the
 * agent may reference them (see assertAttachable).
 */
type LegacyCollaboration = { agents?: Array<{ agentId: string }>; judgeAgentId?: string };
type ParticipantLike = { kind?: string; agentId?: string } | null | undefined;

export function collectAgentReferences(agent: {
  toolIds?: string[] | null;
  pipeline?: AgentPipeline | null;
  collaboration?: Agent['collaboration'] | LegacyCollaboration | null;
}): { toolIds: Set<string>; agentIds: Set<string> } {
  const toolIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const id of agent.toolIds ?? []) if (typeof id === 'string' && id) toolIds.add(id);
  for (const node of agent.pipeline?.nodes ?? []) {
    const data: Record<string, any> = (node as any).data || (node as any).config || {};
    if (node.type === 'tool_call' && typeof data.toolId === 'string' && data.toolId) toolIds.add(data.toolId);
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
  return { toolIds, agentIds };
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
  return ids;
}
