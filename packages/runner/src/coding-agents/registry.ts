/**
 * Coding-agent platform catalog — the runner's port of maco's driver registry.
 *
 * One entry per CLI. Binary names, provider families, API-key env vars,
 * config-dir env vars, auto-approve flags, resume mechanisms, and status-marker
 * tables are sourced from maco's drivers (maco-core/src/drivers/*.rs) and the
 * researched feature matrix (maco/docs/briefs/cli-feature-matrix.md, 2026-06-24).
 *
 * Adding a platform = adding a row here. No code branches anywhere else key off
 * the CLI id; everything (detection, spawn-spec, status) reads this table.
 */
import { SPINNER_GLYPHS, PULSE_GLYPHS } from './status.js';
import type { CodingAgentId, CodingAgentSpec, StatusPatterns } from './types.js';

/** Most CLIs share Claude's prompt/busy shape; start from this and tweak. */
function defaultStatus(over: Partial<StatusPatterns> = {}): StatusPatterns {
  return {
    busySubstrings: ['esc to interrupt', 'ctrl+c to interrupt'],
    spinnerGlyphs: SPINNER_GLYPHS,
    promptPrefixes: ['> '],
    promptContains: [],
    promptExact: ['>'],
    ...over,
  };
}

export const CODING_AGENTS: Record<CodingAgentId, CodingAgentSpec> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    shortCode: 'cl',
    binary: 'claude',
    binaryAliases: [],
    providerFamily: 'anthropic',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
    configDirEnvVar: 'CLAUDE_CONFIG_DIR',
    autoApproveArgs: ['--dangerously-skip-permissions'],
    baseArgs: [],
    session: { kind: 'resume-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus({ promptPrefixes: ['>'], promptContains: ['│ >'] }),
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    shortCode: 'cx',
    binary: 'codex',
    binaryAliases: [],
    providerFamily: 'openai',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    configDirEnvVar: 'CODEX_HOME',
    autoApproveArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    baseArgs: [],
    session: { kind: 'exec-resume' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus({
      busySubstrings: ['esc to interrupt', 'working'],
      promptPrefixes: ['>>', '> '],
      promptExact: ['>'],
    }),
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI',
    shortCode: 'gm',
    binary: 'gemini',
    binaryAliases: [],
    providerFamily: 'google',
    apiKeyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    configDirEnvVar: null,
    autoApproveArgs: ['--yolo'],
    baseArgs: [],
    session: { kind: 'resume-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus({
      busySubstrings: ['esc to interrupt', 'esc to cancel'],
      promptContains: ['gemini>'],
    }),
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor Agent',
    shortCode: 'cu',
    binary: 'cursor-agent',
    // NOTE: no bare 'agent' alias — it collides with other tools that install
    // an `agent` binary (e.g. grok), causing false-positive detection. The real
    // Cursor CLI binary is `cursor-agent`.
    binaryAliases: [],
    providerFamily: 'cursor',
    apiKeyEnvVars: ['CURSOR_API_KEY'],
    configDirEnvVar: null,
    autoApproveArgs: ['--force'],
    baseArgs: [],
    session: { kind: 'resume-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus(),
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    shortCode: 'oc',
    binary: 'opencode',
    binaryAliases: [],
    providerFamily: 'unknown',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    configDirEnvVar: null,
    autoApproveArgs: [],
    baseArgs: [],
    session: { kind: 'session-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus({
      busySubstrings: ['esc interrupt', 'esc to exit', 'thinking...', 'generating...'],
      spinnerGlyphs: PULSE_GLYPHS,
      promptContains: ['ask anything'],
    }),
  },
  crush: {
    id: 'crush',
    displayName: 'Crush',
    shortCode: 'cr',
    binary: 'crush',
    binaryAliases: [],
    providerFamily: 'unknown',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    configDirEnvVar: null,
    autoApproveArgs: ['--yolo'],
    baseArgs: [],
    session: { kind: 'session-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus(),
  },
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    shortCode: 'cp',
    binary: 'copilot',
    binaryAliases: [],
    providerFamily: 'github',
    apiKeyEnvVars: ['COPILOT_GITHUB_TOKEN', 'GITHUB_TOKEN'],
    configDirEnvVar: 'COPILOT_HOME',
    autoApproveArgs: ['--yolo'],
    baseArgs: [],
    session: { kind: 'session-id-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus({ promptContains: ['copilot>'] }),
  },
  grok: {
    id: 'grok',
    displayName: 'Grok CLI',
    shortCode: 'gr',
    binary: 'grok',
    binaryAliases: [],
    providerFamily: 'xai',
    apiKeyEnvVars: ['XAI_API_KEY'],
    configDirEnvVar: null,
    // grok needs --no-alt-screen so its output renders in the scrollback we scrape.
    autoApproveArgs: ['--always-approve', '--no-alt-screen'],
    baseArgs: [],
    session: { kind: 'session-id-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus(),
  },
  hermes: {
    id: 'hermes',
    displayName: 'Hermes',
    shortCode: 'hr',
    binary: 'hermes',
    binaryAliases: [],
    providerFamily: 'nous',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    configDirEnvVar: 'HERMES_HOME',
    autoApproveArgs: ['--yolo'],
    baseArgs: [],
    session: { kind: 'resume-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus(),
  },
  mistral_vibe: {
    id: 'mistral_vibe',
    displayName: 'Mistral Vibe',
    shortCode: 'mv',
    binary: 'vibe',
    binaryAliases: ['mistral-vibe'],
    providerFamily: 'mistral',
    apiKeyEnvVars: ['MISTRAL_API_KEY'],
    configDirEnvVar: 'VIBE_HOME',
    autoApproveArgs: ['--yolo'],
    baseArgs: [],
    session: { kind: 'resume-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus(),
  },
  openclaw: {
    id: 'openclaw',
    displayName: 'OpenClaw',
    shortCode: 'ow',
    binary: 'openclaw',
    binaryAliases: [],
    providerFamily: 'unknown',
    apiKeyEnvVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    configDirEnvVar: 'OPENCLAW_CONFIG_PATH',
    autoApproveArgs: ['exec-policy', 'preset', 'yolo'],
    baseArgs: ['chat', '--local'],
    session: { kind: 'session-id-flag' },
    supportsMcp: true,
    canManage: true,
    status: defaultStatus(),
  },
  // aider is not a maco driver, but the runner already probed it and it's a
  // widely used coding CLI; include it so detection/spawn cover it too.
  aider: {
    id: 'aider',
    displayName: 'Aider',
    shortCode: 'ai',
    binary: 'aider',
    binaryAliases: [],
    providerFamily: 'unknown',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    configDirEnvVar: null,
    autoApproveArgs: ['--yes-always'],
    baseArgs: [],
    session: { kind: 'none' },
    supportsMcp: false,
    canManage: false,
    status: defaultStatus(),
  },
};

export const CODING_AGENT_IDS = Object.keys(CODING_AGENTS) as CodingAgentId[];

export function listCodingAgents(): CodingAgentSpec[] {
  return CODING_AGENT_IDS.map((id) => CODING_AGENTS[id]);
}

export function getCodingAgent(id: string): CodingAgentSpec | undefined {
  return (CODING_AGENTS as Record<string, CodingAgentSpec>)[id];
}

/** Resolve a spec by binary name or alias (e.g. "cursor-agent" → cursor). */
export function findByBinary(binaryName: string): CodingAgentSpec | undefined {
  for (const spec of listCodingAgents()) {
    if (spec.binary === binaryName || spec.binaryAliases.includes(binaryName)) return spec;
  }
  return undefined;
}

/** Every binary name (primary + aliases) for the probe list. */
export function allProbeBinaries(): string[] {
  const set = new Set<string>();
  for (const spec of listCodingAgents()) {
    set.add(spec.binary);
    for (const a of spec.binaryAliases) set.add(a);
  }
  return [...set];
}
