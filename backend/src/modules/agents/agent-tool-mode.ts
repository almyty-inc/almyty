/**
 * How an autonomous agent's model sees its tools (docs/design/code-mode.md,
 * part E, decisions 8 and 9).
 *
 *   direct    every tool's full definition, as before
 *   discover  the meta-tools (search_tools, get_tool, call_tool) and any
 *             pinned tools; the model finds the rest on demand
 *   code      discover, plus run_code: the model can write a short script
 *             that calls the tools, run in a locked sandbox (code-mode/)
 *   auto      direct while the definitions are small, discover above the
 *             threshold (decision 8: discover only, until the benchmark shows
 *             code winning; code is never picked for an agent)
 *
 * The threshold (decision 9) is a share of the main model's context window
 * (AGENT_TOOL_MODE_THRESHOLD_PERCENT, default 3%), or
 * AGENT_TOOL_MODE_FALLBACK_TOKENS (default 4000) when the model card has no
 * context length, and an agent may set its own (`toolModeThresholdTokens`).
 * The choice is made once, on a run's first step, and kept for the run, so
 * the tools array does not change between steps.
 */
import { codeModeProblems } from '../code-mode/code-write-policy';

export type ToolMode = 'direct' | 'discover' | 'code' | 'auto';
export type EffectiveToolMode = 'direct' | 'discover' | 'code';

export interface ToolModeDecision {
  mode: EffectiveToolMode;
  configured: ToolMode;
  estimatedTokens: number;
  thresholdTokens: number;
}

type Env = Record<string, string | undefined>;

function numberSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function isToolMode(value: unknown): value is ToolMode {
  return value === 'direct' || value === 'discover' || value === 'code' || value === 'auto';
}

export interface ToolModeSettings {
  /** The mode of an agent that sets none (AGENT_TOOL_MODE_DEFAULT, default auto). */
  defaultMode: ToolMode;
  thresholdPercent: number;
  fallbackTokens: number;
}

export function toolModeSettings(env: Env = process.env): ToolModeSettings {
  const configured = env.AGENT_TOOL_MODE_DEFAULT?.trim();
  return {
    defaultMode: isToolMode(configured) ? configured : 'auto',
    thresholdPercent: numberSetting(env, 'AGENT_TOOL_MODE_THRESHOLD_PERCENT', 3, 0.1, 100),
    fallbackTokens: numberSetting(env, 'AGENT_TOOL_MODE_FALLBACK_TOKENS', 4_000, 100, 10_000_000),
  };
}

/**
 * Tokens the definitions take in a request, estimated as a quarter of their
 * JSON length (the usual four characters per token). An estimate is enough:
 * it only picks between two modes.
 */
export function estimateToolTokens(definitions: unknown[]): number {
  if (!definitions.length) return 0;
  return Math.ceil(JSON.stringify(definitions).length / 4);
}

/** The token count above which `auto` discovers. */
export function thresholdTokens(contextLength: number | null | undefined, override?: number | null, env: Env = process.env): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return Math.floor(override);
  const settings = toolModeSettings(env);
  if (typeof contextLength === 'number' && contextLength > 0) return Math.floor((contextLength * settings.thresholdPercent) / 100);
  return settings.fallbackTokens;
}

export function decideToolMode(input: {
  configured?: unknown;
  definitions: unknown[];
  contextLength?: number | null;
  overrideTokens?: number | null;
  env?: Env;
}): ToolModeDecision {
  const env = input.env ?? process.env;
  const configured: ToolMode = isToolMode(input.configured) ? input.configured : toolModeSettings(env).defaultMode;
  const estimatedTokens = estimateToolTokens(input.definitions);
  const threshold = thresholdTokens(input.contextLength, input.overrideTokens, env);
  // Decision 8: auto never picks code; a person chooses it.
  const mode: EffectiveToolMode =
    configured === 'auto' ? (estimatedTokens > threshold ? 'discover' : 'direct') : configured;
  return { mode, configured, estimatedTokens, thresholdTokens: threshold };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What is wrong with an agent's tool-mode settings, in plain sentences (empty: nothing). */
export function toolModeProblems(agentConfig: Record<string, any> | null | undefined): string[] {
  if (!agentConfig) return [];
  const problems: string[] = [];
  if (agentConfig.toolMode !== undefined && agentConfig.toolMode !== null && !isToolMode(agentConfig.toolMode)) {
    problems.push('Tool mode must be direct, discover, code or auto');
  }
  problems.push(...codeModeProblems(agentConfig.codeMode));
  const threshold = agentConfig.toolModeThresholdTokens;
  if (threshold !== undefined && threshold !== null && !(Number.isInteger(threshold) && threshold > 0 && threshold <= 10_000_000)) {
    problems.push('The tool-mode threshold must be a whole number of tokens between 1 and 10,000,000');
  }
  const pinned = agentConfig.pinnedToolIds;
  if (pinned !== undefined && pinned !== null && !(Array.isArray(pinned) && pinned.every((id) => typeof id === 'string' && UUID_RE.test(id)))) {
    problems.push('Pinned tools must be a list of tool ids');
  }
  return problems;
}
