import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute, resolve as pathResolve } from 'path';

import { allProbeBinaries } from './coding-agents/index.js';
import { ResolvedConfig, RunnerConfig, RunnerIsolationTier } from './types.js';

/**
 * Config layering, lowest precedence first:
 *
 *   1. Built-in defaults (host isolation, network allowed, installs
 *      blocked)
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
  // language runtimes, VCS, package managers, container runtimes
  'node', 'python', 'python3', 'git',
  'npm', 'pip', 'cargo', 'go', 'rustc',
  'docker', 'podman',
  // every coding-agent CLI we support (claude, codex, gemini, cursor-agent,
  // opencode, crush, copilot, grok, hermes, vibe, openclaw, aider, + aliases)
  ...allProbeBinaries(),
];

export const DEFAULT_BACKEND_URL = 'https://api.almyty.com';

export const DEFAULTS: ResolvedConfig = {
  config: {
    /**
     * Host isolation, by default.
     *
     * This is the one default where the restrictive choice is not the
     * right one, because container isolation is not implemented in this
     * build. `policy.ts` knows that and fails closed: with
     * `defaultIsolation: 'container'` every spawn and every shell exec is
     * refused before it starts. So a container default does not produce a
     * sandboxed runner — it produces a runner that denies every command
     * the backend sends it, after the documented quick start said it was
     * ready. A default nobody can use is not a safe default, it is a
     * broken one.
     *
     * So the default is what actually runs, and the exposure is stated
     * rather than implied: a host-isolation runner executes
     * backend-dispatched commands as the user who started it, on their
     * machine. `describeIsolationPosture()` prints that at boot, the
     * README says it in the quick start, and the ways to narrow it
     * (`allowedCwdRoots`, `denyPatterns`, `installBlocked`) are listed
     * next to it.
     *
     * Choosing `container` explicitly still refuses rather than quietly
     * running on the host, which keeps the setting honest for whoever
     * turns it on before the runtime exists.
     */
    defaultIsolation: 'host',
    maxConcurrent: 4,
    allowedCwdRoots: [],
    denyPatterns: [],
    /**
     * Network is not blocked, for the same reason: it cannot be enforced
     * under host isolation, and `policy.ts` refuses every command when it
     * is asked for. Requesting it remains a refusal rather than a lie.
     */
    networkBlocked: false,
    /**
     * Installs stay blocked. This one is enforceable — it is a pattern
     * match on the command, not a sandbox — so it costs nothing to keep
     * and it stops a dispatched payload from mutating the machine's
     * global package state. Narrow enough that a runner still works with
     * it on.
     */
    installBlocked: true,
  },
  name: '',
  labels: {},
  binaryProbeList: DEFAULT_BINARY_PROBE_LIST,
  backendUrl: DEFAULT_BACKEND_URL,
};

/**
 * One line describing what this config lets the runner do, for the boot
 * banner. Pure, so a test can assert the wording without starting a
 * daemon.
 *
 * Host isolation is the default and it means real execution on this
 * machine. Saying so at boot is the trade for the default working: the
 * posture is a choice the user can see, not one buried in a file they
 * never opened.
 */
export function describeIsolationPosture(config: RunnerConfig): string {
  if (config.defaultIsolation === 'container') {
    return (
      'isolation=container — NOT IMPLEMENTED in this build; every command will be refused. ' +
      "Set config.defaultIsolation to 'host' (or ALMYTY_RUNNER_ISOLATION=host) to run commands."
    );
  }
  if (config.networkBlocked) {
    return (
      'networkBlocked=true cannot be enforced under host isolation; every command will be refused. ' +
      'Set networkBlocked to false to run commands.'
    );
  }
  const guards: string[] = [];
  guards.push(config.installBlocked ? 'installs blocked' : 'installs allowed');
  guards.push(
    config.allowedCwdRoots.length > 0
      ? `cwd limited to ${config.allowedCwdRoots.length} root(s)`
      : 'cwd unrestricted',
  );
  if (config.denyPatterns.length > 0) guards.push(`${config.denyPatterns.length} deny pattern(s)`);
  return `isolation=host — commands run on this machine as you (${guards.join(', ')})`;
}

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
  if (env.ALMYTY_ORG_ID) resolved.organizationId = env.ALMYTY_ORG_ID;
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
  if (f.organizationId) resolved.organizationId = f.organizationId;
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

  // The runner's command channel (RCE-capable) and its bearer token ride
  // this URL — refuse plaintext http:// to a remote host. http is allowed
  // only for loopback (local dev).
  try {
    const u = new URL(resolved.backendUrl);
    const host = u.hostname;
    const loopback =
      host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
    if (u.protocol !== 'https:' && !loopback) {
      throw new Error(
        `Refusing an insecure ${u.protocol}// backend URL for a remote host: ${resolved.backendUrl}. ` +
          'Use https:// (http is only allowed for localhost).',
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Refusing')) throw e;
    throw new Error(`Invalid backend URL: ${resolved.backendUrl}`);
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
