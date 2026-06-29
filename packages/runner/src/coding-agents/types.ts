/**
 * Coding-agent platform model.
 *
 * The runner's generic process surface can spawn any binary, but driving a
 * coding CLI unattended needs per-CLI knowledge: the real binary name, the
 * provider API-key env var, the "relocate my whole config/auth/session home"
 * env var (so members don't fight over one shared ~/.config), the auto-approve
 * flag that skips per-tool permission prompts, the resume mechanism, and the
 * VT markers that say whether the pane is busy / idle / waiting on the human.
 *
 * This mirrors maco's `CliDriver` trait, narrowed to what the runner needs:
 * detect → build a spawn spec → classify live status. The catalog is DATA
 * (one entry per CLI in registry.ts) so adding a platform is a table edit,
 * never a new code branch — same design point as maco's driver registry and
 * its config-driven status-pattern tables.
 */

/** Every coding CLI maco supports, by stable id. */
export type CodingAgentId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'opencode'
  | 'crush'
  | 'copilot'
  | 'grok'
  | 'hermes'
  | 'mistral_vibe'
  | 'openclaw'
  | 'aider';

/**
 * How a CLI resumes a prior session. The runner builds the resume argv from
 * this + a session id. (Some CLIs have no resume mechanism we drive yet.)
 */
export type SessionFlavor =
  | { kind: 'resume-flag' } //         binary --resume <id>
  | { kind: 'session-id-flag' } //     binary --session-id <id>
  | { kind: 'session-flag' } //        binary --session <id>
  | { kind: 'exec-resume' } //         binary exec resume <id>
  | { kind: 'none' };

/**
 * Two-tier live status of a spawned coding-agent pane (maco's model):
 *   - busy: actively working (spinner / "esc to interrupt" present)
 *   - idle: at its prompt, ready for the next instruction
 *   - awaiting_input: stopped on a question/permission prompt for the human
 *   - awaiting_auth: stopped on a sign-in / API-key / ToS gate
 *   - error: a crash/fatal marker is on screen
 *   - unknown: no marker matched (caller decides; usually treat as busy)
 */
export type AgentStatus =
  | 'busy'
  | 'idle'
  | 'awaiting_input'
  | 'awaiting_auth'
  | 'error'
  | 'unknown';

/** Per-CLI VT scrape table — markers are data, matched busy-first. */
export interface StatusPatterns {
  /** Lowercased substrings; presence anywhere ⇒ busy. Keep SPECIFIC. */
  busySubstrings: string[];
  /** First non-space char of any line is one of these ⇒ busy (spinner). */
  spinnerGlyphs: string[];
  /** A bottom line whose trimStart() starts with one of these ⇒ idle prompt. */
  promptPrefixes: string[];
  /** A bottom line that contains one of these (raw) ⇒ idle prompt. */
  promptContains: string[];
  /** A bottom line whose trim() equals one of these ⇒ idle prompt. */
  promptExact: string[];
}

export interface CodingAgentSpec {
  /** Stable id used by the agent.* RPC surface. */
  id: CodingAgentId;
  /** Human label, e.g. "Claude Code". */
  displayName: string;
  /** Two-letter code mirroring maco's short_code (status table key). */
  shortCode: string;
  /** The real executable name. */
  binary: string;
  /** Alternate names to also probe (e.g. cursor → cursor-agent). */
  binaryAliases: string[];
  /** Throttle-reroute family (maco's provider_family): 'anthropic', 'openai', … */
  providerFamily: string;
  /**
   * Provider API-key env vars, in priority order. Under an isolated config
   * home the normal credential file is absent, so the key is injected at spawn.
   */
  apiKeyEnvVars: string[];
  /**
   * The CLI's dedicated "relocate config+auth+sessions" env var, if it has one
   * (CODEX_HOME, CLAUDE_CONFIG_DIR, COPILOT_HOME, …). Null ⇒ isolate via HOME.
   */
  configDirEnvVar: string | null;
  /** Argv that skips per-tool permission prompts for an unattended member. */
  autoApproveArgs: string[];
  /** Argv prepended before everything (e.g. openclaw: ['chat','--local']). */
  baseArgs: string[];
  /** How to resume a prior session. */
  session: SessionFlavor;
  /** Does the CLI speak MCP (so the runner can inject coordination tools)? */
  supportsMcp: boolean;
  /** Can it act as the orchestrating manager (vs member-only)? */
  canManage: boolean;
  /** VT status-detection table. */
  status: StatusPatterns;
}

/** A detected, on-PATH coding agent. */
export interface DetectedCodingAgent {
  id: CodingAgentId;
  displayName: string;
  binary: string;
  /** The binary name that actually resolved (may be an alias). */
  resolvedBinary: string;
  version: string;
  providerFamily: string;
  supportsMcp: boolean;
  canManage: boolean;
}
