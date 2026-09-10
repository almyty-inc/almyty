import { Strategy } from '../../../entities/strategy.entity';
import { describeStrategy } from './strategy-compiler';

/**
 * Choosing which strategy to run.
 *
 * A small model reads the request, the strategies as `describe()` gives
 * them, and the eligible models, and answers with a strategy plus role
 * bindings. It is the only layer allowed to make that choice, and it is
 * **off by default**.
 *
 * Three rules shape this file, all of them about failing safely:
 *
 *   1. **Any failure falls back to the configured static strategy.** A
 *      timeout, a malformed answer, a strategy that does not exist: none
 *      of them may stop a run. An orchestrator that can break the product
 *      when it misbehaves is worse than no orchestrator.
 *   2. **Depth is limited to one.** No orchestrator choosing an
 *      orchestrator. Enforced in code rather than documented, because the
 *      failure is unbounded cost.
 *   3. **It is budget-accounted.** The choice costs a call, and a cost
 *      that does not appear in the budget is a cost nobody can see.
 *
 * See docs/design/layers.md, L6.
 */

export interface OrchestratorConfig {
  enabled: boolean;
  /** Role key of the small model that decides. */
  roleKey: string;
  timeoutMs: number;
  /** Used whenever the orchestrator does not produce a usable answer. */
  fallbackStrategyKey: string;
  /** Empty means every strategy the organization can see. */
  allowedStrategyKeys?: string[];
}

export const ORCHESTRATOR_DEFAULTS: OrchestratorConfig = {
  enabled: false,
  roleKey: 'orchestrator',
  timeoutMs: 2000,
  fallbackStrategyKey: 'single',
};

export interface OrchestratorChoice {
  strategyKey: string;
  roleBindings: Record<string, string>;
  reasoning?: string;
  /** How the choice was reached, for the route trace. */
  via: 'orchestrator' | 'fallback';
  /** Why the fallback was used. Absent when the orchestrator answered. */
  fallbackReason?: string;
}

/** Raised when a run is already inside an orchestrated one. */
export class OrchestratorDepthExceeded extends Error {
  readonly code = 'ORCHESTRATOR_DEPTH_EXCEEDED';
  constructor(depth: number) {
    super(`An orchestrator may not choose another orchestrator (depth ${depth}); the limit is one`);
    this.name = 'OrchestratorDepthExceeded';
  }
}

export const MAX_ORCHESTRATOR_DEPTH = 1;

/**
 * Validate the model's answer into a choice.
 *
 * Everything it can get wrong lands here: unparseable, a strategy that
 * does not exist, one the organization is not allowed, or bindings that
 * do not cover the slots. Each returns a reason rather than a throw,
 * because the caller's response to all of them is the same fallback and
 * the reason is what makes the fallback diagnosable.
 */
export function readOrchestratorAnswer(
  raw: string,
  available: Array<Pick<Strategy, 'key' | 'displayName' | 'roleSlots' | 'shape'>>,
  allowed?: string[],
): { ok: true; strategyKey: string; roleBindings: Record<string, string>; reasoning?: string } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false, reason: 'the answer contained no JSON object' };
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return { ok: false, reason: `the answer did not parse: ${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'the answer was not an object' };

  const obj = parsed as Record<string, unknown>;
  const strategyKey = typeof obj.strategy === 'string' ? obj.strategy : undefined;
  if (!strategyKey) return { ok: false, reason: 'the answer named no strategy' };

  const strategy = available.find((s) => s.key === strategyKey);
  if (!strategy) return { ok: false, reason: `it chose "${strategyKey}", which is not a strategy this organization has` };
  if (allowed && allowed.length > 0 && !allowed.includes(strategyKey)) {
    return { ok: false, reason: `it chose "${strategyKey}", which is not in the allowed list` };
  }

  const bindings = (obj.roleBindings ?? {}) as Record<string, unknown>;
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) {
    return { ok: false, reason: 'roleBindings was not an object' };
  }
  const cleaned: Record<string, string> = {};
  for (const [slot, role] of Object.entries(bindings)) {
    if (typeof role !== 'string' || !role) return { ok: false, reason: `roleBindings.${slot} was not a role key` };
    cleaned[slot] = role;
  }
  const missing = (strategy.roleSlots ?? []).filter((slot) => !cleaned[slot]);
  if (missing.length) return { ok: false, reason: `it left these slots unbound: ${missing.join(', ')}` };

  return {
    ok: true,
    strategyKey,
    roleBindings: cleaned,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
  };
}

/** The choice to use when the orchestrator does not give a usable one. */
export function fallbackChoice(config: OrchestratorConfig, reason: string): OrchestratorChoice {
  return { strategyKey: config.fallbackStrategyKey, roleBindings: {}, via: 'fallback', fallbackReason: reason };
}

/**
 * The prompt. Strategies are described rather than dumped: the
 * orchestrator picks a shape, so it needs slots and cost bands, not the
 * step graph.
 */
export function orchestratorPrompt(
  request: string,
  available: Array<Pick<Strategy, 'key' | 'displayName' | 'roleSlots' | 'shape'>>,
  roleKeys: string[],
): string {
  const described = available.map((s) => {
    const d = describeStrategy({ ...s, displayName: s.displayName });
    return `- ${d.key}: ${d.displayName}. slots: ${d.roleSlots.join(', ') || 'none'}. cost ${d.costBand}, latency ${d.latencyBand}.`;
  });
  return [
    'Choose how to carry out this request.',
    '',
    'Request:',
    request,
    '',
    'Available strategies:',
    ...described,
    '',
    `Available roles: ${roleKeys.join(', ') || 'none'}`,
    '',
    'Answer with a single JSON object and nothing else:',
    '  {"strategy": "<key>", "roleBindings": {"<slot>": "<role key>"}, "reasoning": "<one sentence>"}',
    'Bind every slot the strategy needs. Prefer the cheapest shape that will do the job.',
  ].join('\n');
}

/**
 * Run the decision with a hard timeout and a guaranteed answer.
 *
 * `decide` is whatever actually calls the model. It is a parameter so the
 * timeout and fallback can be proven without a model, and so this stays
 * the only place that knows what happens when the answer is bad.
 */
export async function chooseStrategy(
  config: OrchestratorConfig,
  depth: number,
  available: Array<Pick<Strategy, 'key' | 'displayName' | 'roleSlots' | 'shape'>>,
  decide: () => Promise<string>,
  now: () => number = Date.now,
): Promise<OrchestratorChoice> {
  if (depth > MAX_ORCHESTRATOR_DEPTH) throw new OrchestratorDepthExceeded(depth);
  if (!config.enabled) return fallbackChoice(config, 'the orchestrator is disabled');

  let raw: string;
  try {
    raw = await withTimeout(decide(), config.timeoutMs, now);
  } catch (err) {
    return fallbackChoice(config, (err as Error).message);
  }

  const read = readOrchestratorAnswer(raw, available, config.allowedStrategyKeys);
  if (read.ok !== true) return fallbackChoice(config, read.reason);
  return { strategyKey: read.strategyKey, roleBindings: read.roleBindings, reasoning: read.reasoning, via: 'orchestrator' };
}

function withTimeout<T>(promise: Promise<T>, ms: number, now: () => number): Promise<T> {
  const started = now();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`it did not answer within ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        void started;
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
