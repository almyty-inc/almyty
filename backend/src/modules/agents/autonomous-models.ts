import type { RoutingPolicy } from '../model-catalog/routing/model-router';

/**
 * An autonomous agent's models: the roles that work on a request and how
 * they work together.
 *
 * A workflow agent gets its multi-model shape from a strategy compiled to a
 * graph (docs/strategies.md). An autonomous agent has no graph: it runs the
 * ReAct loop, one model call per step. This is the autonomous counterpart,
 * applied per step of that loop by AutonomousStrategyRunner, and stored on
 * the agent row (`agents.models`) because the create/edit page saves the
 * whole agent in one request.
 *
 * The main role is also mirrored into `modelConfig` on every write
 * (`syncMainRole`), so everything that reads the agent's model -- the
 * readiness check, the model-issue banner, compaction, the tech doc --
 * keeps reading the model the loop actually uses.
 *
 * See docs/autonomous-models.md.
 */

/**
 * The strategies the autonomous engine implements. Every key here has a
 * branch in AutonomousStrategyRunner; the frontend's picker is checked
 * against this list by a source guard, so the page cannot offer a shape
 * the loop would ignore.
 */
export const AUTONOMOUS_STRATEGY_KEYS = [
  'single',
  'cascade',
  'best_of_n',
  'panel',
  'explore_extract_patch',
] as const;
export type AutonomousStrategyKey = (typeof AUTONOMOUS_STRATEGY_KEYS)[number];

/** What a role does in the strategy. */
export const ROLE_PURPOSES = [
  'main',
  'drafter',
  'checker',
  'panelist',
  'explorer',
  'summariser',
  'teammate',
] as const;
export type RolePurpose = (typeof ROLE_PURPOSES)[number];

export interface AgentModelRole {
  /** Stable id within the agent; steps and cost lines name it. */
  key: string;
  /** What a person calls it: "Main", "Drafter", "Checker". */
  name: string;
  purpose: RolePurpose;
  /** A model answers with one call; an agent answers with a child run of that agent. */
  kind: 'model' | 'agent';
  providerId?: string;
  model?: string;
  routing?: RoutingPolicy;
  temperature?: number;
  maxTokens?: number;
  agentId?: string;
  /** Extra instructions for this role (a checker's focus, a teammate's brief). */
  instructions?: string;
}

export interface AgentModels {
  strategy: AutonomousStrategyKey;
  roles: AgentModelRole[];
  /** Best of N: how many candidate answers the checker chooses between. */
  candidates?: number;
}

export const BEST_OF_N_DEFAULT = 3;
export const BEST_OF_N_MIN = 2;
export const BEST_OF_N_MAX = 5;

/** Which purposes may be filled by another agent rather than a model. */
export const AGENT_ALLOWED_PURPOSES: readonly RolePurpose[] = ['panelist', 'teammate'];

/**
 * The slots a strategy needs, as purpose -> minimum count. `main` is
 * always needed; it runs the loop.
 */
export const STRATEGY_SLOTS: Record<AutonomousStrategyKey, Partial<Record<RolePurpose, number>>> = {
  single: { main: 1 },
  cascade: { main: 1, drafter: 1, checker: 1 },
  best_of_n: { main: 1, checker: 1 },
  panel: { main: 1, panelist: 2 },
  explore_extract_patch: { main: 1, explorer: 1, summariser: 1, checker: 1 },
};

/** Purposes a strategy reads beyond its required slots. */
const STRATEGY_OPTIONAL: Record<AutonomousStrategyKey, RolePurpose[]> = {
  single: [],
  cascade: [],
  best_of_n: [],
  // The checker judges the panel when there is one; the main role otherwise.
  panel: ['checker'],
  explore_extract_patch: [],
};

/** Purposes with more than one role allowed. */
const MULTIPLE: ReadonlySet<RolePurpose> = new Set(['panelist', 'explorer', 'teammate']);

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const STRATEGY_LABELS: Record<AutonomousStrategyKey, string> = {
  single: 'Single',
  cascade: 'Cascade',
  best_of_n: 'Best of N',
  panel: 'Panel',
  explore_extract_patch: 'Explore, extract, patch',
};

/** The roles of one purpose, in the order the agent lists them. */
export function rolesFor(models: Pick<AgentModels, 'roles'>, purpose: RolePurpose): AgentModelRole[] {
  return models.roles.filter((r) => r.purpose === purpose);
}

/** The slots `strategy` needs that `roles` does not fill, one sentence each. */
export function missingSlots(models: Pick<AgentModels, 'strategy' | 'roles'>): string[] {
  const slots = STRATEGY_SLOTS[models.strategy];
  if (!slots) return [];
  const out: string[] = [];
  for (const [purpose, min] of Object.entries(slots) as Array<[RolePurpose, number]>) {
    const have = models.roles.filter((r) => r.purpose === purpose).length;
    if (have < min) {
      out.push(
        min === 1
          ? `${STRATEGY_LABELS[models.strategy]} needs a ${purpose} role`
          : `${STRATEGY_LABELS[models.strategy]} needs at least ${min} ${purpose} roles (has ${have})`,
      );
    }
  }
  return out;
}

/**
 * Purposes on the agent that its strategy does not read. Not an error --
 * the page says so, rather than refusing the save, so switching strategy
 * back and forth does not throw roles away.
 */
export function unusedPurposes(models: Pick<AgentModels, 'strategy' | 'roles'>): RolePurpose[] {
  const used = new Set<RolePurpose>([
    ...(Object.keys(STRATEGY_SLOTS[models.strategy] ?? {}) as RolePurpose[]),
    ...(STRATEGY_OPTIONAL[models.strategy] ?? []),
    'teammate',
  ]);
  return [...new Set(models.roles.map((r) => r.purpose))].filter((p) => !used.has(p));
}

/**
 * Everything wrong with an agent's models, one sentence per problem.
 * Empty means the engine can run it. `null`/`undefined` is fine: the
 * agent then runs Single on its `modelConfig`.
 */
export function agentModelsProblems(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return ['models must be an object'];
  const m = value as Record<string, any>;
  const problems: string[] = [];

  const knownStrategy = (AUTONOMOUS_STRATEGY_KEYS as readonly string[]).includes(m.strategy);
  if (!knownStrategy) {
    problems.push(`models.strategy "${m.strategy}" is not one of ${AUTONOMOUS_STRATEGY_KEYS.join(', ')}`);
  }
  if (!Array.isArray(m.roles)) {
    problems.push('models.roles must be an array');
    return problems;
  }

  const keys = new Set<string>();
  m.roles.forEach((r: unknown, i: number) => {
    const where = `models.roles[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const role = r as Record<string, any>;
    const label = typeof role.name === 'string' && role.name.trim() ? role.name : role.key;
    if (typeof role.key !== 'string' || !KEY_PATTERN.test(role.key)) {
      problems.push(`${where}.key must be lowercase letters, digits and underscores, starting with a letter`);
    } else if (keys.has(role.key)) {
      problems.push(`${where}.key "${role.key}" is used by another role`);
    } else {
      keys.add(role.key);
    }
    if (typeof role.name !== 'string' || !role.name.trim()) problems.push(`${where} needs a name`);
    const knownPurpose = (ROLE_PURPOSES as readonly string[]).includes(role.purpose);
    if (!knownPurpose) {
      problems.push(`${where}.purpose "${role.purpose}" is not one of ${ROLE_PURPOSES.join(', ')}`);
    }
    if (role.kind === 'agent') {
      if (typeof role.agentId !== 'string' || !role.agentId.trim()) {
        problems.push(`${where} (${label}) is an agent role without an agentId`);
      }
      if (knownPurpose && !AGENT_ALLOWED_PURPOSES.includes(role.purpose)) {
        problems.push(
          `${label} is another agent, and a ${role.purpose} has to be a model: only panelists and teammates can be agents`,
        );
      }
    } else if (role.kind === 'model') {
      const hasProvider = typeof role.providerId === 'string' && role.providerId.trim() !== '';
      const hasRouting = !!role.routing && typeof role.routing === 'object' && !Array.isArray(role.routing);
      if (!hasProvider && !hasRouting) {
        problems.push(`${label} needs a provider or a routing policy`);
      }
      if (
        role.temperature !== undefined &&
        role.temperature !== null &&
        (typeof role.temperature !== 'number' || role.temperature < 0 || role.temperature > 2)
      ) {
        problems.push(`${label}: temperature must be a number from 0 to 2`);
      }
      if (
        role.maxTokens !== undefined &&
        role.maxTokens !== null &&
        (!Number.isInteger(role.maxTokens) || role.maxTokens < 1)
      ) {
        problems.push(`${label}: max tokens must be a positive whole number`);
      }
    } else {
      problems.push(`${where}.kind "${role.kind}" is not "model" or "agent"`);
    }
  });

  for (const purpose of ROLE_PURPOSES) {
    if (MULTIPLE.has(purpose)) continue;
    const n = m.roles.filter((r: any) => r?.purpose === purpose).length;
    if (n > 1) problems.push(`There are ${n} ${purpose} roles; there can be one`);
  }

  if (m.candidates !== undefined && m.candidates !== null) {
    if (!Number.isInteger(m.candidates) || m.candidates < BEST_OF_N_MIN || m.candidates > BEST_OF_N_MAX) {
      problems.push(`models.candidates must be a whole number from ${BEST_OF_N_MIN} to ${BEST_OF_N_MAX}`);
    }
  }

  if (knownStrategy) {
    problems.push(
      ...missingSlots({ strategy: m.strategy, roles: m.roles.filter((r: any) => r && typeof r === 'object') }),
    );
  }
  return problems;
}

type ModelConfigLike =
  | {
      providerId?: string;
      model?: string;
      routing?: RoutingPolicy;
      temperature?: number;
      maxTokens?: number;
      [other: string]: any;
    }
  | null
  | undefined;

/** The call settings `modelConfig` and the main role share. */
export const MAIN_ROLE_FIELDS = ['providerId', 'model', 'routing', 'temperature', 'maxTokens'] as const;

/** A Single strategy whose one role is the model `modelConfig` names; null when it names none. */
export function modelsFromModelConfig(modelConfig: ModelConfigLike): AgentModels | null {
  if (!modelConfig || (!modelConfig.providerId && !modelConfig.routing)) return null;
  const main: Record<string, any> = { key: 'main', name: 'Main', purpose: 'main', kind: 'model' };
  for (const f of MAIN_ROLE_FIELDS) {
    if (modelConfig[f] !== undefined && modelConfig[f] !== null) main[f] = modelConfig[f];
  }
  return { strategy: 'single', roles: [main as AgentModelRole] };
}

/**
 * Keep `models` and `modelConfig` saying the same thing about the main
 * role, whichever one a write changed.
 *
 * - `models` written: the main role's call settings are copied onto
 *   `modelConfig`; its other keys (compaction, history) are kept.
 * - only `modelConfig` written (an API or MCP client that predates
 *   `models`): the main role is updated from it, or a Single strategy is
 *   made when the agent had no models yet.
 */
export function syncMainRole(input: {
  models: AgentModels | null | undefined;
  modelConfig: ModelConfigLike;
  modelsWritten: boolean;
}): { models: AgentModels | null; modelConfig: ModelConfigLike } {
  const { models, modelConfig, modelsWritten } = input;
  if (modelsWritten && models) {
    const main = models.roles.find((r) => r.purpose === 'main');
    if (!main || main.kind !== 'model') return { models, modelConfig };
    const next: Record<string, any> = { ...(modelConfig ?? {}) };
    for (const f of MAIN_ROLE_FIELDS) {
      if (main[f] === undefined || main[f] === null) delete next[f];
      else next[f] = main[f];
    }
    return { models, modelConfig: next };
  }
  if (!models) return { models: modelsFromModelConfig(modelConfig), modelConfig };
  if (!modelConfig) return { models, modelConfig };
  const roles = models.roles.map((r) => {
    if (r.purpose !== 'main') return r;
    const next: Record<string, any> = { ...r, kind: 'model' };
    for (const f of MAIN_ROLE_FIELDS) {
      if (modelConfig[f] === undefined || modelConfig[f] === null) delete next[f];
      else next[f] = modelConfig[f];
    }
    return next as AgentModelRole;
  });
  return { models: { ...models, roles }, modelConfig };
}
