/**
 * Build a runner SpawnOptions for a coding-agent platform.
 *
 * This is the lever maco drives from its driver layer (`coordination_argv`,
 * `coordination_env`, auto-approve, resume), narrowed to what the runner needs
 * to launch an unattended member:
 *
 *   - inject the provider API key into the CLI's env (headless auth — under an
 *     isolated config home the normal credential file is absent);
 *   - isolate the CLI's config/auth/session home via its dedicated env var
 *     (CODEX_HOME, CLAUDE_CONFIG_DIR, …) so parallel members don't collide;
 *   - add the auto-approve flag so the member doesn't stop on per-tool prompts;
 *   - add resume argv when continuing a prior session;
 *   - optionally pin a model.
 *
 * The result is a plain SpawnOptions the existing ProcessManager runs as-is;
 * the runner's execution policy still applies on top.
 */
import type { SpawnOptions } from '../types.js';
import type { CodingAgentSpec } from './types.js';

export interface AgentSpawnInput {
  /** Provider API key to inject (matched to the CLI's first apiKeyEnvVar). */
  apiKey?: string;
  /** Explicit env var name for the key, overriding the spec's default order. */
  apiKeyEnvVar?: string;
  /**
   * Isolated config/auth/session home for this member. Set on the CLI's
   * dedicated env var if it has one; otherwise exported as HOME so the CLI's
   * default ~/.<cli> path relocates under it.
   */
  configDir?: string;
  /** Skip per-tool permission prompts (unattended member). Default true. */
  autoApprove?: boolean;
  /** Pin a model where the CLI's argv supports it (best-effort, claude/gemini). */
  model?: string;
  /** Resume a prior session id (uses the spec's SessionFlavor). */
  resumeSessionId?: string;
  /** Extra argv appended last (e.g. a one-shot prompt or CLI-specific flags). */
  extraArgs?: string[];
  /** Working directory for the member. */
  cwd?: string;
  /** Base env to extend. Defaults to {} (policy/process-manager add the rest). */
  baseEnv?: Record<string, string>;
}

/** Argv that resumes a session for this CLI, or [] if unsupported. */
export function resumeArgv(spec: CodingAgentSpec, sessionId: string): string[] {
  switch (spec.session.kind) {
    case 'resume-flag': return ['--resume', sessionId];
    case 'session-id-flag': return ['--session-id', sessionId];
    case 'session-flag': return ['--session', sessionId];
    case 'exec-resume': return ['exec', 'resume', sessionId];
    case 'none': return [];
  }
}

/** Best-effort model-pin argv (only the CLIs that take a plain --model flag). */
function modelArgv(spec: CodingAgentSpec, model: string): string[] {
  if (spec.id === 'claude' || spec.id === 'gemini') return ['--model', model];
  return [];
}

export function buildAgentSpawn(spec: CodingAgentSpec, input: AgentSpawnInput = {}): SpawnOptions {
  const args: string[] = [...spec.baseArgs];

  // Resume vs fresh session.
  if (input.resumeSessionId) {
    args.push(...resumeArgv(spec, input.resumeSessionId));
  }

  // Auto-approve (default on — these members run unattended).
  if (input.autoApprove !== false) {
    args.push(...spec.autoApproveArgs);
  }

  // Model pin where supported.
  if (input.model) {
    args.push(...modelArgv(spec, input.model));
  }

  // Caller extras last so they can override.
  if (input.extraArgs?.length) {
    args.push(...input.extraArgs);
  }

  const env: Record<string, string> = { ...(input.baseEnv ?? {}) };

  // Headless auth: inject the provider key on the CLI's expected env var.
  if (input.apiKey) {
    const keyVar = input.apiKeyEnvVar ?? spec.apiKeyEnvVars[0];
    if (keyVar) env[keyVar] = input.apiKey;
  }

  // Config/auth/session isolation. Prefer the CLI's dedicated env var; fall
  // back to HOME so the default ~/.<cli> path relocates under the isolated dir.
  if (input.configDir) {
    if (spec.configDirEnvVar) env[spec.configDirEnvVar] = input.configDir;
    else env.HOME = input.configDir;
  }

  return {
    binary: spec.binary,
    args,
    env: Object.keys(env).length ? env : undefined,
    pty: true,
    cwd: input.cwd,
  };
}
