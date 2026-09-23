import type { RoutingPolicy } from '../model-catalog/routing/model-router';

/**
 * One member of an autonomous agent's collaboration.
 *
 * An `agent` participant is another agent, run as a child run with its own
 * tools and loop. A `model` participant is a single model call: a provider
 * (`providerId`, with `model` or the provider's default model) or a routing
 * policy that lets the catalog pick the model. A model participant needs
 * `providerId` or `routing`; a `model` alone names nothing callable.
 */
export type CollaborationParticipant =
  | { kind: 'agent'; agentId: string; role?: string }
  | {
      kind: 'model';
      providerId?: string;
      model?: string;
      routing?: RoutingPolicy;
      role?: string;
      instructions?: string;
      temperature?: number;
      maxTokens?: number;
    };

export type CollaborationStrategy = 'sequential' | 'parallel' | 'race' | 'debate';

export const COLLABORATION_STRATEGIES: readonly CollaborationStrategy[] = [
  'sequential',
  'parallel',
  'race',
  'debate',
];

export interface CollaborationRules {
  maxTotalCost?: number;
  maxChainDepth?: number;
  outputFormat?: 'text' | 'json';
  escalation?: 'never' | 'on_failure' | 'on_low_confidence';
  conflictResolution?: 'judge' | 'majority' | 'first_wins' | 'merge';
}

export interface AgentCollaboration {
  strategy: CollaborationStrategy;
  participants: CollaborationParticipant[];
  sharedBrief?: string;
  rules?: CollaborationRules;
  judge?: CollaborationParticipant;
  maxRounds?: number;
}

/**
 * Everything wrong with a collaboration config, one sentence per problem.
 * Empty means it can be saved. `null`/`undefined` (no collaboration) is fine.
 */
export function collaborationProblems(collab: unknown): string[] {
  if (collab === null || collab === undefined) return [];
  if (typeof collab !== 'object' || Array.isArray(collab)) {
    return ['collaboration must be an object'];
  }
  const c = collab as Record<string, any>;
  const problems: string[] = [];

  if (!COLLABORATION_STRATEGIES.includes(c.strategy)) {
    problems.push(
      `collaboration.strategy "${c.strategy}" is not one of ${COLLABORATION_STRATEGIES.join(', ')}`,
    );
  }
  if (c.participants !== undefined && !Array.isArray(c.participants)) {
    problems.push('collaboration.participants must be an array');
  } else {
    (c.participants ?? []).forEach((p: unknown, i: number) => {
      problems.push(...participantProblems(p, `collaboration.participants[${i}]`));
    });
  }
  if (c.judge !== undefined && c.judge !== null) {
    problems.push(...participantProblems(c.judge, 'collaboration.judge'));
  }
  return problems;
}

function participantProblems(p: unknown, where: string): string[] {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return [`${where} must be an object`];
  const q = p as Record<string, any>;
  if (q.kind === 'agent') {
    return typeof q.agentId === 'string' && q.agentId.trim()
      ? []
      : [`${where} is an agent participant without an agentId`];
  }
  if (q.kind === 'model') {
    const hasProvider = typeof q.providerId === 'string' && q.providerId.trim() !== '';
    const hasRouting = !!q.routing && typeof q.routing === 'object';
    if (hasProvider || hasRouting) return [];
    if (q.model) {
      return [`${where} names model "${q.model}" but no providerId or routing policy to call it through`];
    }
    return [`${where} is a model participant with neither a providerId nor a routing policy`];
  }
  return [`${where} has unknown kind "${q.kind}" (expected "agent" or "model")`];
}

/** A short human name for a participant: its role, else what it runs. */
export function participantLabel(p: CollaborationParticipant): string {
  if (p.role) return p.role;
  if (p.kind === 'agent') return p.agentId;
  return p.model || 'routed model';
}

/**
 * The collaboration context a participant is told about: which strategy it is
 * part of, its role, the shared brief and the rules of engagement. An agent
 * participant gets it in its system prompt (AgentRuntimeBuilders) and a model
 * participant in the system message of its call (AgentCollaborationHelper),
 * from this one function, so the two cannot drift apart.
 */
export function buildCollaborationContext(
  collab: Partial<AgentCollaboration> | null | undefined,
  role?: string,
): string[] {
  const lines: string[] = [];
  if (role && collab?.strategy) {
    lines.push(`You are the "${role}" in a ${collab.strategy} collaboration.`);
  } else if (collab?.strategy) {
    lines.push(`You are participating in a ${collab.strategy} collaboration.`);
  }
  if (collab?.sharedBrief) {
    lines.push(`Brief: ${collab.sharedBrief}`);
  }
  if (collab?.rules) {
    const rulesParts: string[] = [];
    if (collab.rules.maxTotalCost) rulesParts.push(`max cost $${collab.rules.maxTotalCost}`);
    if (collab.rules.outputFormat) rulesParts.push(`output format: ${collab.rules.outputFormat}`);
    if (collab.rules.escalation) rulesParts.push(`escalation: ${collab.rules.escalation}`);
    if (collab.rules.conflictResolution) rulesParts.push(`conflict resolution: ${collab.rules.conflictResolution}`);
    if (rulesParts.length > 0) lines.push(`Rules: ${rulesParts.join(', ')}`);
  }
  if (collab?.participants?.length) {
    lines.push(`Team members: ${collab.participants.map(participantLabel).join(', ')}`);
  }
  return lines;
}
