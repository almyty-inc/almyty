import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute, resolve as pathResolve } from 'path';

import { ResolvedConfig, RunnerConfig, RunnerIsolationTier } from './types.js';

/**
 * Config layering, lowest precedence first:
 *
 *   1. Built-in defaults (most restrictive: container isolation,
 *      no network, no installs)
 *   2. ~/.almyty/config.json                                  (global user)
 *   3. ./.almyty/config.json                                  (project-local)
 *   4. Environment variables (ALMYTY_*)
 *   5. CLI flags
 *
 * Backend overrides apply at registration time and only constrain
 * (lower limits, smaller path allowlists, more deny patterns); they
 * never escalate. Backend overrides aren't applied here — they merge
 * in after the runner registers and the backend returns its
 * effective config.
 *
 * The format mirrors the convention `@almyty/auth` already established:
 * plain JSON, owner-readable, in `~/.almyty/`. No TOML, no YAML, no
 * cosmiconfig.
 */

export const DEFAULT_BINARY_PROBE_LIST = [
  'node', 'python', 'python3', 'git',
  'claude', 'codex', 'gemini', 'aider',
  'npm', 'pip', 'cargo', 'go', 'rustc',
  'docker', 'podman',
];

export const DEFAULT_BACKEND_URL = 'https://api.almyty.com';

export const DEFAULTS: ResolvedConfig = {
  name: '',
  labels: {},
  config: {
    // Most-restrictive defaults: container isolation, no installs,
    // no network. Users opt out of any of these explicitly in config
    // or via flags; the design point is that an unconfigured runner
    // is the safest one.
    defaultIsolation: 'container',
    maxConcurrent: 4,
    allowedCwdRoots: [],
    denyPatterns: [],
    networkBlocked: true,
    installBlocked: true,
  },
  binaryProbeList: DEFAULT_BINARY_PROBE_LIST,
  backendUrl: DEFAULT_BACKEND_URL,
};

export const GLOBAL_CONFIG_PATH = join(homedir(), '.almyty', 'config.json');
export const PROJECT_CONFIG_PATH = join(process.cwd(), '.almyty', 'config.json');

/**
 * Inputs to the loader, after argv has been parsed but before any
 * file IO. The loader stays pure-ish: it takes filesystem readers and
 * env as parameters so tests can substitute them without monkey-
 * patching `fs` or `process.env`.
 */
export interface LoadConfigInputs {
  /** CLI flag overrides. Highest precedence. */
  flags?: Partial<ResolvedConfig> & { configPath?: string };
  /** Explicit env map. Defaults to process.env at call site. */
  env?: Record<string, string | undefined>;
  /** Filesystem reader. Defaults to fs.readFileSync. */
  readFile?: (path: string) => string | null;
  /** File existence check. */
  exists?: (path: string) => boolean;
  /** Override global config path (testing). */
  globalPath?: string;
  /** Override project config path (testing). */
  projectPath?: string;
}

export function loadConfig(inputs: LoadConfigInputs = {}): ResolvedConfig {
  const env = inputs.env ?? process.env;
  const readFile = inputs.readFile ?? safeRead;
  const exists = inputs.exists ?? existsSync;
  const globalPath = inputs.globalPath ?? GLOBAL_CONFIG_PATH;
  const projectPath = inputs.projectPath ?? PROJECT_CONFIG_PATH;

  let resolved: ResolvedConfig = clone(DEFAULTS);

  // Layer 2: global config file.
  if (exists(globalPath)) {
    resolved = mergeIn(resolved, parseConfigFile(readFile(globalPath), globalPath));
  }
  // Layer 3: project-local config file.
  if (exists(projectPath)) {
    resolved = mergeIn(resolved, parseConfigFile(readFile(projectPath), projectPath));
  }
  // Layer 3.5: explicit --config <path> takes precedence over both
  // global and project, but the spec orders it as a flag (layer 4).
  // Treat it as a flag-driven file load: same precedence as flags.
  if (inputs.flags?.configPath) {
    const explicit = inputs.flags.configPath;
    const abs = isAbsolute(explicit) ? explicit : pathResolve(process.cwd(), explicit);
    if (!exists(abs)) {
      throw new Error(`config file not found: ${abs}`);
    }
    resolved = mergeIn(resolved, parseConfigFile(readFile(abs), abs));
  }

  // Layer 4: env overrides. Limited to the few fields it makes sense
  // to set without a config file: backend URL, runner name, isolation.
  if (env.ALMYTY_URL) resolved.backendUrl = env.ALMYTY_URL;
  if (env.ALMYTY_RUNNER_NAME) resolved.name = env.ALMYTY_RUNNER_NAME;
  if (env.ALMYTY_RUNNER_ISOLATION) {
    if (!isIsolation(env.ALMYTY_RUNNER_ISOLATION)) {
      throw new Error(`ALMYTY_RUNNER_ISOLATION must be one of: container, host`);
    }
    resolved.config.defaultIsolation = env.ALMYTY_RUNNER_ISOLATION;
  }

  // Layer 5: CLI flags. Most have already been validated by the
  // parser; we just merge.
  const f = inputs.flags ?? {};
  if (f.name) resolved.name = f.name;
  if (f.labels) resolved.labels = { ...resolved.labels, ...f.labels };
  if (f.backendUrl) resolved.backendUrl = f.backendUrl;
  if (f.config) resolved.config = mergeRunnerConfig(resolved.config, f.config);
  if (f.binaryProbeList && f.binaryProbeList.length > 0) {
    resolved.binaryProbeList = f.binaryProbeList;
  }

  if (!resolved.name) {
    // A runner without a name is meaningless: the backend keys
    // single-runner enforcement on (user, org, name). Surface a
    // clear error early rather than letting the registration call
    // fail with a less-helpful message.
    throw new Error('runner name is required (set via --name, ALMYTY_RUNNER_NAME, or config.name)');
  }
  return resolved;
}

// ── helpers ─────────────────────────────────────────────────────────

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function parseConfigFile(text: string | null, path: string): Partial<ResolvedConfig> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<ResolvedConfig>) : {};
  } catch (err: any) {
    throw new Error(`failed to parse ${path}: ${err.message}`);
  }
}

function mergeIn(into: ResolvedConfig, layer: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    name: layer.name ?? into.name,
    labels: { ...into.labels, ...(layer.labels ?? {}) },
    backendUrl: layer.backendUrl ?? into.backendUrl,
    binaryProbeList: layer.binaryProbeList && layer.binaryProbeList.length > 0
      ? layer.binaryProbeList
      : into.binaryProbeList,
    config: layer.config ? mergeRunnerConfig(into.config, layer.config) : into.config,
  };
}

function mergeRunnerConfig(base: RunnerConfig, layer: Partial<RunnerConfig>): RunnerConfig {
  return {
    defaultIsolation: layer.defaultIsolation ?? base.defaultIsolation,
    maxConcurrent: layer.maxConcurrent ?? base.maxConcurrent,
    allowedCwdRoots: layer.allowedCwdRoots ?? base.allowedCwdRoots,
    denyPatterns: layer.denyPatterns ?? base.denyPatterns,
    networkBlocked: layer.networkBlocked ?? base.networkBlocked,
    installBlocked: layer.installBlocked ?? base.installBlocked,
  };
}

function isIsolation(value: string): value is RunnerIsolationTier {
  return value === 'container' || value === 'host';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
