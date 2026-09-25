import type { RoutingPolicy } from './models'

/**
 * An autonomous agent's models: the roles that work on a request and the
 * strategy they work in. Mirrors backend/src/modules/agents/autonomous-models.ts;
 * the builder's rules mirror is checked against that file by a source guard.
 */
export type AutonomousStrategyKey = 'single' | 'cascade' | 'best_of_n' | 'panel' | 'explore_extract_patch'

export type RolePurpose = 'main' | 'drafter' | 'checker' | 'panelist' | 'explorer' | 'summariser' | 'teammate'

export interface AgentModelRole {
  /** Stable id within the agent; steps and cost lines name it. */
  key: string
  /** What a person calls it: "Main", "Drafter", "Checker". */
  name: string
  purpose: RolePurpose
  /** A model answers with one call; an agent answers with a run of its own. */
  kind: 'model' | 'agent'
  providerId?: string
  model?: string
  routing?: RoutingPolicy
  temperature?: number
  maxTokens?: number
  agentId?: string
  /** Extra instructions for this role (a checker's focus, a teammate's brief). */
  instructions?: string
}

export interface AgentModels {
  strategy: AutonomousStrategyKey
  roles: AgentModelRole[]
  /** Best of N: how many candidate answers the checker chooses between (2..5). */
  candidates?: number
}

/** Who acted on a step of an autonomous run. */
export interface RunStepRole {
  key: string
  name: string
  purpose: RolePurpose | string
  kind: 'model' | 'agent'
}

/** One line of `run.metadata.roleCosts`. */
export interface RoleCost {
  name: string
  purpose: RolePurpose | string
  cost: number
  tokens: number | { input: number; output: number }
  calls: number
}
