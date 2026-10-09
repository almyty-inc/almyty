import type { Agent } from '../../entities/agent.entity';

/**
 * An autonomous agent's Capabilities section, as the server reads it.
 *
 *  - `apiIds`: APIs it may use, every tool of each, including tools added
 *    to the API later (resolved at run time, active tools only), on top of
 *    the single tools in `toolIds`.
 *  - `callableAgentIds`: the other agents it may call or hand work to,
 *    offered to its model as `call_agent_*` tools. `canCallAgents` is kept
 *    equal to "the list is not empty"; an API client that sets only the
 *    switch still means every agent the run could start.
 *  - `runnerLabels`: labels a machine its runner tools run on must have.
 *  - `runnerId`: the one runner its runner tools run on, when pinned.
 *  - `canCreateAgents` with `maxTemporaryAgents` (per run) and
 *    `maxTemporaryAgentsAlive` (existing at once, across its runs).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TEMPORARY_AGENTS_MAX = 20;

type Config = NonNullable<Agent['agentConfig']>;

/** Whether this agent may call `targetId`. The run's scope is checked separately. */
export function mayCallAgent(agent: Pick<Agent, 'id' | 'agentConfig'>, targetId: string): boolean {
  if (targetId === agent.id) return false;
  const cfg = agent.agentConfig;
  if (!cfg) return false;
  if (Array.isArray(cfg.callableAgentIds)) return cfg.callableAgentIds.includes(targetId);
  return cfg.canCallAgents === true;
}

/** Whether this agent may call any agent at all. */
export function callsAgents(agent: Pick<Agent, 'agentConfig'>): boolean {
  const cfg = agent.agentConfig;
  if (!cfg) return false;
  if (Array.isArray(cfg.callableAgentIds)) return cfg.callableAgentIds.length > 0;
  return cfg.canCallAgents === true;
}

/**
 * Its temporary agent limits. 0 when it may not create any; null when
 * nothing bounds it (an API client that set only `canCreateAgents`).
 */
export function temporaryAgentLimits(agent: Pick<Agent, 'agentConfig'>): { perRun: number | null; alive: number | null } {
  const cfg = agent.agentConfig;
  if (!cfg?.canCreateAgents) return { perRun: 0, alive: 0 };
  const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  return { perRun: n(cfg.maxTemporaryAgents), alive: n(cfg.maxTemporaryAgentsAlive) };
}

/** The APIs whose tools it may use. */
export function agentApiIds(agent: Pick<Agent, 'agentConfig'>): string[] {
  const ids = agent.agentConfig?.apiIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
}

/**
 * The one runner its runner tools run on, when it is pinned to one
 * (`agentConfig.runnerId`); null for "any of my runners". A pinned call
 * goes to that runner whichever runner published the tool, and fails
 * plainly when that runner is offline, rather than going elsewhere.
 */
export function agentRunnerId(agent: Pick<Agent, 'agentConfig'> | null | undefined): string | null {
  const id = agent?.agentConfig?.runnerId;
  return typeof id === 'string' && id ? id : null;
}

/** The hosted environment an agent's runner-backed tools run on, or null. */
export function agentEnvironmentId(agent: Pick<Agent, 'agentConfig'> | null | undefined): string | null {
  const id = agent?.agentConfig?.environmentId;
  return typeof id === 'string' && id ? id : null;
}

const dedupe = (ids: string[]) => [...new Set(ids)];

/** Tidy what a save writes: lists without repeats, the switch equal to the list. */
export function normaliseCapabilities(cfg: Partial<Config> | null | undefined): void {
  if (!cfg) return;
  if (Array.isArray(cfg.callableAgentIds)) {
    cfg.callableAgentIds = dedupe(cfg.callableAgentIds);
    cfg.canCallAgents = cfg.callableAgentIds.length > 0;
  }
  if (Array.isArray(cfg.apiIds)) cfg.apiIds = dedupe(cfg.apiIds);
  // "Any of my runners" is stored as no pin at all.
  if (cfg.runnerId === null || cfg.runnerId === '') delete cfg.runnerId;
  if (cfg.environmentId === null || cfg.environmentId === '') delete cfg.environmentId;
}

/** Everything wrong with the capability fields, one sentence each. */
export function capabilityProblems(cfg: unknown): string[] {
  if (cfg === null || cfg === undefined || typeof cfg !== 'object') return [];
  const c = cfg as Record<string, unknown>;
  const problems: string[] = [];
  const ids = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
  if (c.callableAgentIds !== undefined && !ids(c.callableAgentIds)) problems.push('The agents it may call must be a list of agent ids');
  if (c.apiIds !== undefined && !ids(c.apiIds)) problems.push('The APIs it may use must be a list of API ids');
  const limit = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= TEMPORARY_AGENTS_MAX);
  if (!limit(c.maxTemporaryAgents)) problems.push(`Temporary agents per run must be a whole number from 1 to ${TEMPORARY_AGENTS_MAX}`);
  if (!limit(c.maxTemporaryAgentsAlive)) problems.push(`Temporary agents alive at once must be a whole number from 1 to ${TEMPORARY_AGENTS_MAX}`);
  if (c.runnerId !== undefined && c.runnerId !== null && !(typeof c.runnerId === 'string' && UUID_RE.test(c.runnerId))) problems.push('The runner it runs on must be a runner id');
  if (c.environmentId !== undefined && c.environmentId !== null && !(typeof c.environmentId === 'string' && UUID_RE.test(c.environmentId))) problems.push('The environment it runs on must be an environment id');
  const labels = c.runnerLabels;
  const hasLabels = !!labels && (typeof labels === 'string' ? labels.trim().length > 0 : typeof labels === 'object' && Object.keys(labels as object).length > 0);
  if (typeof c.environmentId === 'string' && c.environmentId && ((typeof c.runnerId === 'string' && c.runnerId) || hasLabels)) {
    problems.push('An agent runs on a hosted environment or on your own machines, not both: clear the runner and machine labels, or the environment');
  }
  return problems;
}
