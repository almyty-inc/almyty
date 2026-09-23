/**
 * Collaboration: who else works on each request, and in what order.
 *
 * A participant is another agent or a model (a provider and model, or a
 * routing policy). Models are first-class so an organization with a single
 * agent can still run several models in sequence, in parallel, as a race
 * or as a debate; "no other agents" is not a dead end. Mirrors
 * `CollaborationParticipant` on the backend Agent entity.
 */
import type { RoutingPolicy } from '@/types/models'

export type CollaborationStrategy = 'sequential' | 'parallel' | 'race' | 'debate'

export interface AgentParticipant {
  kind: 'agent'
  agentId: string
  role?: string
}

export interface ModelParticipant {
  kind: 'model'
  providerId?: string
  model?: string
  routing?: RoutingPolicy
  role?: string
  instructions?: string
  temperature?: number
  maxTokens?: number
}

export type CollaborationParticipant = AgentParticipant | ModelParticipant

export interface CollaborationRules {
  maxTotalCost?: number
  maxChainDepth?: number
  outputFormat?: 'text' | 'json'
  escalation?: 'never' | 'on_failure' | 'on_low_confidence'
  conflictResolution?: 'judge' | 'majority' | 'first_wins' | 'merge'
}

/** The builder's state: the saved shape plus the on/off switch. */
export interface CollaborationState {
  enabled: boolean
  strategy: CollaborationStrategy
  participants: CollaborationParticipant[]
  sharedBrief?: string
  rules?: CollaborationRules
  judge?: CollaborationParticipant
  maxRounds?: number
}

export const EMPTY_COLLABORATION: CollaborationState = {
  enabled: false,
  strategy: 'sequential',
  participants: [],
  rules: {},
}

/** A model participant is runnable once it names a provider or a policy. */
export function modelParticipantReady(p: ModelParticipant): boolean {
  return !!p.providerId || !!p.routing
}

/**
 * What stops this collaboration from saving, in the builder's voice.
 *
 * Switching collaboration on and adding nobody used to save as "off"
 * without a word; it now says so instead.
 */
export function collaborationProblems(c: CollaborationState): string[] {
  if (!c.enabled) return []
  const problems: string[] = []
  if (c.participants.length === 0) {
    problems.push('Add a model or an agent to the collaboration, or switch it off')
  }
  c.participants.forEach((p, i) => {
    if (p.kind === 'model' && !modelParticipantReady(p)) {
      problems.push(`Pick a provider for collaboration participant ${i + 1}, or route it by policy`)
    }
    if (p.kind === 'agent' && !p.agentId) {
      problems.push(`Pick the agent for collaboration participant ${i + 1}`)
    }
  })
  if (c.judge?.kind === 'model' && !modelParticipantReady(c.judge)) {
    problems.push('Pick a provider for the judge, or route it by policy')
  }
  return problems
}

/** The value PATCHed to /agents/:id, or null when collaboration is off. */
export function collaborationPayload(c: CollaborationState) {
  if (!c.enabled || c.participants.length === 0) return null
  const hasRules = !!c.rules && Object.values(c.rules).some((v) => v !== undefined && v !== null)
  const judgeUsed = c.strategy === 'parallel' || c.strategy === 'debate'
  return {
    strategy: c.strategy,
    participants: c.participants,
    sharedBrief: c.sharedBrief || undefined,
    rules: hasRules ? c.rules : undefined,
    judge: judgeUsed ? c.judge : undefined,
    maxRounds: c.strategy === 'debate' ? c.maxRounds : undefined,
  }
}

/** Builder state from a saved agent. */
export function collaborationFromAgent(saved: any): CollaborationState {
  if (!saved) return EMPTY_COLLABORATION
  return {
    enabled: true,
    strategy: saved.strategy ?? 'sequential',
    participants: Array.isArray(saved.participants) ? saved.participants : [],
    sharedBrief: saved.sharedBrief,
    rules: saved.rules ?? {},
    judge: saved.judge,
    maxRounds: saved.maxRounds,
  }
}
