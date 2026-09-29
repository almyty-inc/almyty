import type { Agent } from '../../entities/agent.entity';
import type { AgentRun } from '../../entities/agent-run.entity';
import type { RoutingPolicy } from '../model-catalog/routing/model-router';
import {
  AgentModelRole,
  AutonomousStrategyKey,
  BEST_OF_N_DEFAULT,
  MAIN_ROLE_FIELDS,
  RolePurpose,
  missingSlots,
} from './autonomous-models';

/**
 * The roles one autonomous step works with, resolved from the agent.
 *
 * Pure: it reads the agent row (and the run's per-run state) and returns
 * which role fills which slot, with the call settings each model role
 * uses. The step processor asks it once per step, so an edit to the
 * agent's models takes effect on the next step of a running run, the
 * same as an edit to its instructions.
 */

/** A role that answers with one model call. */
export interface ModelRoleCall {
  key: string;
  name: string;
  purpose: RolePurpose;
  kind: 'model';
  providerId?: string;
  model?: string;
  routing?: RoutingPolicy;
  temperature?: number;
  maxTokens?: number;
  instructions?: string;
}

/** A role that answers with a child run of another agent. */
export interface AgentRoleCall {
  key: string;
  name: string;
  purpose: RolePurpose;
  kind: 'agent';
  agentId: string;
  instructions?: string;
}

export type TeamRole = ModelRoleCall | AgentRoleCall;

export interface Team {
  strategy: AutonomousStrategyKey;
  main: ModelRoleCall;
  drafter?: ModelRoleCall;
  checker?: ModelRoleCall;
  summariser?: ModelRoleCall;
  panelists: TeamRole[];
  explorers: ModelRoleCall[];
  teammates: TeamRole[];
  /** Best of N: how many answers the checker chooses between. */
  candidates: number;
}

/** What a step records about the role that acted. */
export interface RoleStamp {
  key: string;
  name: string;
  purpose: RolePurpose;
  kind: 'model' | 'agent';
}

export function stampOf(role: TeamRole): RoleStamp {
  return { key: role.key, name: role.name, purpose: role.purpose, kind: role.kind };
}

export class TeamConfigError extends Error {
  readonly code = 'AGENT_MODELS_INCOMPLETE';
  constructor(message: string) {
    super(message);
    this.name = 'TeamConfigError';
  }
}

function toCall(role: AgentModelRole): TeamRole {
  if (role.kind === 'agent') {
    return {
      key: role.key,
      name: role.name,
      purpose: role.purpose,
      kind: 'agent',
      agentId: role.agentId as string,
      ...(role.instructions ? { instructions: role.instructions } : {}),
    };
  }
  const call: ModelRoleCall = { key: role.key, name: role.name, purpose: role.purpose, kind: 'model' };
  for (const f of MAIN_ROLE_FIELDS) {
    if (role[f] !== undefined && role[f] !== null) (call as any)[f] = role[f];
  }
  if (role.instructions) call.instructions = role.instructions;
  return call;
}

function modelOnly(role: TeamRole | undefined, purpose: string): ModelRoleCall | undefined {
  if (!role) return undefined;
  if (role.kind !== 'model') {
    throw new TeamConfigError(`The ${purpose} role "${role.name}" is an agent; a ${purpose} has to be a model.`);
  }
  return role;
}

/**
 * The team for one step of `run`.
 *
 * The main role's call settings come from `modelConfig`, which every
 * write keeps equal to the main role (syncMainRole) and which a
 * per-request override patches on a throwaway copy of the agent, so the
 * loop answers on exactly what the agent row and the request say.
 *
 * A run started with `metadata.actAs` (an explorer's own run) acts as that
 * one role, alone: strategy Single, no teammates.
 */
export function teamOf(
  agent: Pick<Agent, 'models' | 'modelConfig'>,
  run?: Pick<AgentRun, 'metadata'> | null,
): Team {
  const models = agent.models;
  const roles = (models?.roles ?? []).map(toCall);

  const actAs = run?.metadata?.actAs;
  if (typeof actAs === 'string' && actAs) {
    const role = roles.find((r) => r.key === actAs);
    if (!role) throw new TeamConfigError(`This run acts as role "${actAs}", which the agent no longer has.`);
    return { strategy: 'single', main: modelOnly(role, role.purpose)!, panelists: [], explorers: [], teammates: [], candidates: 1 };
  }

  const declaredMain = roles.find((r) => r.purpose === 'main');
  const main: ModelRoleCall = {
    key: declaredMain?.key ?? 'main',
    name: declaredMain?.name ?? 'Main',
    purpose: 'main',
    kind: 'model',
    ...(declaredMain?.instructions ? { instructions: declaredMain.instructions } : {}),
  };
  const mc = agent.modelConfig ?? {};
  for (const f of MAIN_ROLE_FIELDS) {
    if ((mc as any)[f] !== undefined && (mc as any)[f] !== null) (main as any)[f] = (mc as any)[f];
  }

  const strategy: AutonomousStrategyKey = models?.strategy ?? 'single';
  if (models) {
    const missing = missingSlots({ strategy, roles: models.roles });
    if (missing.length) {
      throw new TeamConfigError(`${missing.join('; ')}. Add the missing roles on the agent's page.`);
    }
  }
  const one = (purpose: RolePurpose) => roles.find((r) => r.purpose === purpose);
  const many = (purpose: RolePurpose) => roles.filter((r) => r.purpose === purpose);

  return {
    strategy,
    main,
    drafter: modelOnly(one('drafter'), 'drafter'),
    checker: modelOnly(one('checker'), 'checker'),
    summariser: modelOnly(one('summariser'), 'summariser'),
    panelists: many('panelist'),
    explorers: many('explorer').map((r) => modelOnly(r, 'explorer')!),
    teammates: many('teammate'),
    candidates: strategy === 'best_of_n' ? (models?.candidates ?? BEST_OF_N_DEFAULT) : 1,
  };
}

/** The tool name a teammate is offered as. */
export function teammateToolName(role: Pick<TeamRole, 'key'>): string {
  return `ask_${role.key}`;
}

/**
 * Whether a strategy picks among candidate answers or checks them before
 * one is final. Such a run must not show a candidate to a visitor before
 * the choice is made, so it neither composes a streamed answer nor lets a
 * surface stream a step's reply (final-answer.ts).
 */
export function strategyWithholdsCandidates(agent: Pick<Agent, 'models'>): boolean {
  const strategy = agent.models?.strategy;
  return !!strategy && strategy !== 'single';
}
