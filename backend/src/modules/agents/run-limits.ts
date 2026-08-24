import { Agent } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { Organization } from '../../entities/organization.entity';

/**
 * Run limits: the single set of ceilings that bound one agent run.
 *
 * There is exactly one run-scoped ledger and it is the `agent_runs` row
 * itself — `currentStep`, `totalTokens`, `totalCost`, `executionTime`,
 * and `recursionDepth`. Nothing here introduces a second accumulator.
 * A nested run (sub-agent, collaboration, a future recursive call)
 * inherits its parent's resolved limits and increments
 * `recursionDepth`, so nesting stays inside the same budget rather
 * than starting a fresh one alongside it.
 *
 * Resolution is min-wins across four scopes:
 *
 *   hard ceiling  (env, operator-owned)  <- nothing can exceed this
 *   organization  (organization.agentDefaults)
 *   agent         (agent.agentConfig.runLimits)
 *   run           (per-call overrides, e.g. AgentRun.limits)
 *
 * The narrower scope may only tighten. An agent cannot raise its own
 * ceiling above organization policy, and neither can raise it above the
 * operator's hard ceiling. Resolution happens at the point of use, not
 * at save time, so tightening org policy takes effect on the next run
 * without rewriting any agent rows.
 */

/** What happens when the context budget is reached mid run. */
export type TruncationPolicy = 'drop_oldest' | 'summarise' | 'fail';

/** How a failed tool call's error text re-enters the model's context. */
export type ToolErrorFeedback = 'full' | 'summarised' | 'suppressed';

export interface RunLimitsInput {
  /** Hard cap on autonomous loop iterations. */
  maxSteps?: number;
  /** Max total tokens across the run. */
  maxTokens?: number;
  /** Max spend for the run, in cents of the organization's currency. */
  maxCostCents?: number;
  /** Wall-clock timeout for the run. */
  maxDurationMs?: number;
  maxToolCalls?: number;
  /** How deep sub-agent / recursive nesting may go. Depth 0 is the run itself. */
  maxRecursionDepth?: number;
  truncationPolicy?: TruncationPolicy;
  toolErrorRetries?: number;
  toolErrorFeedback?: ToolErrorFeedback;
}

export interface ResolvedRunLimits {
  maxSteps: number;
  maxTokens: number;
  maxCostCents: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxRecursionDepth: number;
  truncationPolicy: TruncationPolicy;
  toolErrorRetries: number;
  toolErrorFeedback: ToolErrorFeedback;
}

/**
 * Applied when no scope specifies a value. These match the defaults
 * already in the codebase (maxSteps 50 from the agent_runs column,
 * toolErrorRetries 3 from tool-executor.service.ts) rather than
 * introducing new ones: churning an existing default would quietly
 * change behaviour for every agent that never configured a ceiling.
 */
export const DEFAULT_RUN_LIMITS: ResolvedRunLimits = Object.freeze({
  maxSteps: 50,
  maxTokens: 500_000,
  maxCostCents: 100,
  maxDurationMs: 15 * 60 * 1000,
  maxToolCalls: 100,
  maxRecursionDepth: 3,
  truncationPolicy: 'drop_oldest',
  toolErrorRetries: 3,
  toolErrorFeedback: 'full',
});

/**
 * The operator's ceiling. Read from the environment so a self-hoster can
 * raise or lower it for their whole deployment, and so no agent, no
 * organization admin, and no API caller can raise it from inside the
 * product. This is what stops a runaway agent.
 */
export const HARD_CEILING_ENV_KEYS = Object.freeze({
  maxSteps: 'RUN_LIMIT_MAX_STEPS',
  maxTokens: 'RUN_LIMIT_MAX_TOKENS',
  maxCostCents: 'RUN_LIMIT_MAX_COST_CENTS',
  maxDurationMs: 'RUN_LIMIT_MAX_DURATION_MS',
  maxToolCalls: 'RUN_LIMIT_MAX_TOOL_CALLS',
  maxRecursionDepth: 'RUN_LIMIT_MAX_RECURSION_DEPTH',
});

const HARD_CEILING_FALLBACK = Object.freeze({
  maxSteps: 100,
  maxTokens: 2_000_000,
  maxCostCents: 500,
  maxDurationMs: 60 * 60 * 1000,
  maxToolCalls: 200,
  maxRecursionDepth: 5,
});

type NumericLimitKey = keyof typeof HARD_CEILING_FALLBACK;

const NUMERIC_LIMIT_KEYS = Object.keys(HARD_CEILING_FALLBACK) as NumericLimitKey[];

/**
 * Restrictiveness ranking for the enum limits, most restrictive first.
 * Min-wins applies to these the same way it applies to the numbers: an
 * agent may tighten what the organization set, never loosen it.
 */
const TRUNCATION_RANK: TruncationPolicy[] = ['fail', 'summarise', 'drop_oldest'];
const TOOL_ERROR_FEEDBACK_RANK: ToolErrorFeedback[] = ['suppressed', 'summarised', 'full'];

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/** Read the operator ceiling out of an env-shaped bag, falling back per key. */
export function hardCeiling(env: Record<string, any> = process.env): Record<NumericLimitKey, number> {
  const out = {} as Record<NumericLimitKey, number>;
  for (const key of NUMERIC_LIMIT_KEYS) {
    out[key] = positiveInt(env[HARD_CEILING_ENV_KEYS[key]]) ?? HARD_CEILING_FALLBACK[key];
  }
  return out;
}

/**
 * Organization-level ceiling. `agentDefaults.maxCostPerRun` is in whole
 * currency units (it predates the cents convention), so it is converted
 * here rather than at every call site.
 */
export function organizationRunLimits(org?: Organization | null): RunLimitsInput {
  const defaults = org?.agentDefaults;
  if (!defaults) return {};
  const limits: RunLimitsInput = {};
  const steps = positiveInt(defaults.maxStepsPerRun);
  if (steps !== undefined) limits.maxSteps = steps;
  const cost = typeof defaults.maxCostPerRun === 'number' ? defaults.maxCostPerRun : undefined;
  if (cost !== undefined && cost > 0) limits.maxCostCents = Math.floor(cost * 100);
  return limits;
}

/** Agent-level ceiling, edited in the builder's Run limits section. */
export function agentRunLimits(agent?: Agent | null): RunLimitsInput {
  return (agent?.agentConfig as any)?.runLimits ?? {};
}

/**
 * Run-scoped request: whatever the caller asked for. `AgentRun.maxSteps`
 * is a column rather than part of the `limits` json, so it is folded in
 * here to keep every caller reading one shape.
 */
export function runRequestedLimits(run?: Partial<AgentRun> | null): RunLimitsInput {
  if (!run) return {};
  const requested: RunLimitsInput = { ...(run.limits ?? {}) };
  const steps = positiveInt(run.maxSteps);
  if (steps !== undefined && requested.maxSteps === undefined) requested.maxSteps = steps;
  return requested;
}

function mostRestrictive<T extends string>(rank: T[], values: Array<T | undefined>): T | undefined {
  let best: T | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    const index = rank.indexOf(value);
    if (index < 0) continue;
    if (best === undefined || index < rank.indexOf(best)) best = value;
  }
  return best;
}

export interface ResolveRunLimitsArgs {
  organization?: Organization | null;
  agent?: Agent | null;
  run?: Partial<AgentRun> | null;
  /** Explicit per-call overrides that are not on the run row yet. */
  requested?: RunLimitsInput;
  env?: Record<string, any>;
}

/**
 * Resolve the ceilings that apply to one run. Min-wins across every
 * scope, then clamped to the operator hard ceiling. Call this at the
 * point of use; do not persist the result as policy.
 */
export function resolveRunLimits(args: ResolveRunLimitsArgs = {}): ResolvedRunLimits {
  const ceiling = hardCeiling(args.env);
  const scopes: RunLimitsInput[] = [
    organizationRunLimits(args.organization),
    agentRunLimits(args.agent),
    runRequestedLimits(args.run),
    args.requested ?? {},
  ];

  const resolved = { ...DEFAULT_RUN_LIMITS } as ResolvedRunLimits;

  for (const key of NUMERIC_LIMIT_KEYS) {
    const candidates = scopes
      .map((scope) => positiveInt(scope[key]))
      .filter((n): n is number => n !== undefined);
    // No scope asked for anything, so the default stands. Either way the
    // operator ceiling is the last word.
    const wanted = candidates.length > 0 ? Math.min(...candidates) : DEFAULT_RUN_LIMITS[key];
    resolved[key] = Math.min(wanted, ceiling[key]);
  }

  resolved.truncationPolicy =
    mostRestrictive(
      TRUNCATION_RANK,
      scopes.map((s) => s.truncationPolicy),
    ) ?? DEFAULT_RUN_LIMITS.truncationPolicy;

  resolved.toolErrorFeedback =
    mostRestrictive(
      TOOL_ERROR_FEEDBACK_RANK,
      scopes.map((s) => s.toolErrorFeedback),
    ) ?? DEFAULT_RUN_LIMITS.toolErrorFeedback;

  const retries = scopes
    .map((s) => (typeof s.toolErrorRetries === 'number' && s.toolErrorRetries >= 0
      ? Math.floor(s.toolErrorRetries)
      : undefined))
    .filter((n): n is number => n !== undefined);
  resolved.toolErrorRetries =
    retries.length > 0 ? Math.min(...retries) : DEFAULT_RUN_LIMITS.toolErrorRetries;

  return resolved;
}

/**
 * Machine-readable reason codes, each paired with an explanation a
 * person can act on. A run that trips a limit fails with the code AND
 * the sentence, never a silent stop, so the caller can decide whether to
 * retry smaller, raise the ceiling, or escalate.
 */
export const RUN_LIMIT_REASONS = Object.freeze({
  MAX_STEPS_EXCEEDED:
    'The run reached its maximum number of steps. Raise max steps on the agent, or split the work across more than one run.',
  BUDGET_EXCEEDED:
    'The run reached its cost cap. Raise the cost cap on the agent, or reduce how much work each run does.',
  TIMEOUT:
    'The run reached its wall-clock timeout. Raise the timeout on the agent, or move long work to a scheduled run.',
  TOKEN_LIMIT_EXCEEDED:
    'The run reached its token budget. Raise the token budget, or turn on context compaction so older turns are summarised instead of accumulating.',
  TOOL_CALL_LIMIT_EXCEEDED:
    'The run reached its maximum number of tool calls. Raise the tool-call limit, or narrow which tools the agent may reach.',
  RECURSION_DEPTH_EXCEEDED:
    'The run nested sub-agents deeper than the allowed recursion depth. Flatten the agent graph, or raise the recursion depth.',
  CONTEXT_BUDGET_EXCEEDED:
    'The context budget was reached and the truncation policy is set to fail. Switch the policy to drop oldest or summarise to let the run continue.',
});

export type RunLimitReasonCode = keyof typeof RUN_LIMIT_REASONS;

export interface RunLimitTrip {
  code: RunLimitReasonCode;
  message: string;
}

export function describeLimitTrip(code: RunLimitReasonCode): RunLimitTrip {
  return { code, message: RUN_LIMIT_REASONS[code] };
}

/**
 * Evaluate the ledger against the resolved ceilings.
 *
 * Unit note: `run.totalCost` accumulates `llmResponse.cost`, which
 * LlmProvidersService.calculateProviderCost returns in DOLLARS, while
 * `maxCostCents` is in cents. The x100 is deliberate; without it the
 * comparison silently allowed a 100x overrun.
 */
export function checkRunLimits(
  run: Pick<
    AgentRun,
    'currentStep' | 'totalCost' | 'totalTokens' | 'createdAt'
  > & { recursionDepth?: number; toolCallCount?: number },
  limits: ResolvedRunLimits,
  now: number = Date.now(),
): RunLimitTrip | null {
  if (run.currentStep >= limits.maxSteps) return describeLimitTrip('MAX_STEPS_EXCEEDED');
  if ((run.totalCost ?? 0) * 100 >= limits.maxCostCents) return describeLimitTrip('BUDGET_EXCEEDED');
  if (run.createdAt && now - new Date(run.createdAt).getTime() > limits.maxDurationMs) {
    return describeLimitTrip('TIMEOUT');
  }
  if ((run.totalTokens ?? 0) >= limits.maxTokens) return describeLimitTrip('TOKEN_LIMIT_EXCEEDED');
  if ((run.toolCallCount ?? 0) >= limits.maxToolCalls) {
    return describeLimitTrip('TOOL_CALL_LIMIT_EXCEEDED');
  }
  if ((run.recursionDepth ?? 0) > limits.maxRecursionDepth) {
    return describeLimitTrip('RECURSION_DEPTH_EXCEEDED');
  }
  return null;
}
