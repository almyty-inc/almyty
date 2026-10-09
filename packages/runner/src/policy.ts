/**
 * Runner execution policy enforcement.
 *
 * The runner config advertises an isolation tier, a cwd allowlist, deny
 * patterns, a network-blocked flag, and an install-blocked flag. Until
 * this module these were *documented but never enforced* — every
 * `process.spawn` / `shell.exec` ran any backend-supplied command on the
 * host, with attacker-controllable env, regardless of config. That is host
 * RCE behind a config that lies about protecting the user.
 *
 * This enforces the contract before any spawn:
 *   - Fail closed when `defaultIsolation: 'container'` is configured but no
 *     container runtime is implemented (the default) — refuse rather than
 *     silently run on the host. Host execution is opt-in (`isolation: host`).
 *   - Fail closed when `networkBlocked` is requested (can't be honoured on
 *     the host).
 *   - Reject commands matching `denyPatterns`, and package installs when
 *     `installBlocked`.
 *   - Constrain `cwd` to `allowedCwdRoots` (realpath-canonicalized to block
 *     symlink/`..` escape).
 *   - Strip env keys a payload must never set (PATH, LD_PRELOAD, …).
 *   - When `allowBinaries` is set, refuse a binary it does not list (the
 *     binary of a spawn, every command a shell line starts).
 */
import { realpathSync } from 'fs';
import { resolve, sep } from 'path';
import { RunnerConfig, RunnerError, RUNNER_ERROR_CODES } from './types.js';

// Env vars a payload must never override: they redirect which binary runs
// (PATH), preload code into the process (LD_PRELOAD and friends), or change
// interpreter behaviour. The daemon's own values are kept by stripping
// these from the inbound env before it's merged over process.env.
const BLOCKED_ENV_KEYS = new Set(
  [
    'PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'BASH_ENV',
    'ENV',
    'IFS',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_EXEC_PATH',
    'PROMPT_COMMAND',
  ].map((k) => k.toUpperCase()),
);

const INSTALL_RE =
  /\b(?:npm\s+(?:i|install|ci|add)|yarn\s+add|pnpm\s+(?:add|install|i)|pip3?\s+install|gem\s+install|cargo\s+install|go\s+install|apt(?:-get)?\s+install|brew\s+install|nix-env|conda\s+install)\b/i;

/** Drop env keys a payload must not be allowed to set. */
export function sanitizeEnv(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env) return env;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (BLOCKED_ENV_KEYS.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  return out;
}

function assertIsolationSupported(config: RunnerConfig): void {
  if (config.defaultIsolation === 'container') {
    throw new RunnerError(
      'container isolation is configured but not implemented by this runner build; ' +
        "refusing to run on the host. Set isolation to 'host' to explicitly allow host execution.",
      RUNNER_ERROR_CODES.COMMAND_DENIED,
    );
  }
  if (config.networkBlocked) {
    throw new RunnerError(
      'networkBlocked is set but cannot be enforced under host isolation; refusing to run.',
      RUNNER_ERROR_CODES.COMMAND_DENIED,
    );
  }
}

function matchesDeny(command: string, patterns: string[]): string | null {
  for (const pat of patterns) {
    if (!pat) continue;
    try {
      if (new RegExp(pat).test(command)) return pat;
    } catch {
      // Invalid regex — fall back to a literal substring match so a
      // malformed pattern still denies rather than silently allowing.
      if (command.includes(pat)) return pat;
    }
  }
  return null;
}

function assertCommandAllowed(config: RunnerConfig, command: string): void {
  const deny = matchesDeny(command, config.denyPatterns ?? []);
  if (deny) {
    throw new RunnerError(
      `command blocked by denyPattern: ${deny}`,
      RUNNER_ERROR_CODES.COMMAND_DENIED,
    );
  }
  if (config.installBlocked && INSTALL_RE.test(command)) {
    throw new RunnerError(
      'package installation is blocked by runner policy (installBlocked)',
      RUNNER_ERROR_CODES.COMMAND_DENIED,
    );
  }
}

// ── allowBinaries ───────────────────────────────────────────────────
//
// A hosted environment may name the binaries its runner starts
// (`egress.allowBinaries`, docs/design/hosted-runners-and-always-on.md).
// Inside the pod's sandbox this is a guard rail, not the boundary: an
// allowed shell, interpreter or wrapper (bash, sh, python, node, env, xargs,
// npm scripts) can still start anything, and the policy says so rather
// than pretending otherwise.
//
// An entry without a slash allows that bare command name, found on PATH
// (which a payload cannot change, BLOCKED_ENV_KEYS). An entry with a slash
// allows exactly that absolute path. `./claude` is neither.

/** Bare command names: letters, digits and . _ + - (no slash, no space). */
const BINARY_NAME_RE = /^[A-Za-z0-9._+-]+$/;

/**
 * Shell builtins that cannot start another program themselves, so a
 * command line like `cd app && npm test` needs only npm listed. Builtins
 * that run their arguments (exec, eval, command, builtin, source, ., trap)
 * are not here: they need listing like any binary.
 */
const SAFE_BUILTINS = new Set([
  'cd', 'echo', 'printf', 'pwd', 'export', 'unset', 'set', 'test', '[', '[[', ']]',
  'true', 'false', ':', 'exit', 'return', 'shift', 'read', 'wait', 'umask',
]);

/** Shell words that open or close a construct; the command follows them. */
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'time', '{', '}', 'esac']);

/** Constructs whose first segment names variables or patterns, not a command. */
const NON_COMMAND_SEGMENTS = new Set(['for', 'case', 'select', 'function']);

/**
 * Parse an allowBinaries list from its environment form: a JSON array of
 * strings (what the backend writes). Anything else throws, so a runner
 * with a list it cannot read refuses to start rather than running
 * unrestricted.
 */
export function parseAllowBinaries(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ALMYTY_ALLOW_BINARIES must be a JSON array of binary names');
  }
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
    throw new Error('ALMYTY_ALLOW_BINARIES must be a JSON array of binary names');
  }
  const out = [...new Set((parsed as string[]).map((v) => v.trim()))];
  for (const entry of out) {
    if (!(BINARY_NAME_RE.test(entry) || (entry.startsWith('/') && !/\s/.test(entry)))) {
      throw new Error(`ALMYTY_ALLOW_BINARIES: "${entry}" is neither a command name nor an absolute path`);
    }
  }
  return out.length ? out : undefined;
}

/**
 * The config with an allowBinaries list applied. Only ever narrows: when
 * the config already has a list, the result is the intersection, and an
 * empty intersection throws rather than lifting the restriction.
 */
export function withAllowBinaries(config: RunnerConfig, allow: string[] | undefined): RunnerConfig {
  if (!allow || allow.length === 0) return config;
  if (!config.allowBinaries?.length) return { ...config, allowBinaries: [...allow] };
  const current = new Set(config.allowBinaries);
  const next = allow.filter((b) => current.has(b));
  if (next.length === 0) throw new Error('allowBinaries: the environment and the runner config allow no binary in common');
  return { ...config, allowBinaries: next };
}

function binaryAllowed(allow: string[], binary: string): boolean {
  return binary.includes('/') ? binary.startsWith('/') && allow.includes(binary) : allow.includes(binary);
}

function denyBinary(binary: string): never {
  throw new RunnerError(`binary not in allowBinaries: ${binary}`, RUNNER_ERROR_CODES.COMMAND_DENIED);
}

function assertBinaryAllowed(config: RunnerConfig, binary: string): void {
  const allow = config.allowBinaries;
  if (!allow || allow.length === 0) return;
  if (!binaryAllowed(allow, binary)) denyBinary(binary);
}

/**
 * The command names a shell command line would start: the first word of
 * every simple command, including those inside $( ), backticks, ( ), <( )
 * and >( ), after variable assignments, redirections and keywords. Quotes
 * and backslashes are removed from the word (`"rm"` is rm). A word that is
 * built at run time ($VAR, a glob) is returned as is and never matches an
 * entry, so it is refused.
 *
 * Best effort by design: separators inside quotes split too, which can
 * refuse a harmless line (`echo "a; b"` checks `b`) but never lets a
 * command through unseen.
 */
export function commandHeads(cmd: string): string[] {
  const normalized = cmd
    .replace(/\d*[<>]&(?:\d+|-)/g, ' ') // 2>&1, >&2, <&-
    .replace(/&>>?/g, ' >'); // &> file
  const segments = normalized.split(/\$\(|[<>]\(|\|\||&&|;;|[;&|\n()`]/);
  const heads: string[] = [];
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const w = words[i];
      if (SHELL_KEYWORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(w)) {
        i += 1;
      } else if (/^\d*(?:<<?<?|>>?|>\|)$/.test(w)) {
        i += 2; // a redirection and its target
      } else if (/^\d*(?:<<?<?|>>?|>\|)\S/.test(w)) {
        i += 1; // a redirection glued to its target
      } else {
        break;
      }
    }
    if (i >= words.length) continue;
    if (NON_COMMAND_SEGMENTS.has(words[i])) continue;
    heads.push(words[i].replace(/["'\\]/g, ''));
  }
  return heads;
}

function assertShellBinariesAllowed(config: RunnerConfig, cmd: string): void {
  const allow = config.allowBinaries;
  if (!allow || allow.length === 0) return;
  for (const head of commandHeads(cmd)) {
    if (SAFE_BUILTINS.has(head)) continue;
    if (!binaryAllowed(allow, head)) denyBinary(head);
  }
}

function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs); // resolve symlinks to block escape via a link
  } catch {
    return abs; // path may legitimately not exist yet
  }
}

function assertCwdAllowed(config: RunnerConfig, cwd: string | undefined): void {
  const roots = config.allowedCwdRoots ?? [];
  if (roots.length === 0) return; // no restriction configured
  if (!cwd) {
    throw new RunnerError(
      'cwd is required when allowedCwdRoots is configured',
      RUNNER_ERROR_CODES.PATH_DENIED,
    );
  }
  const real = canonical(cwd);
  const allowed = roots.some((root) => {
    const r = canonical(root);
    return real === r || real.startsWith(r + sep);
  });
  if (!allowed) {
    throw new RunnerError(
      `cwd is outside allowedCwdRoots: ${cwd}`,
      RUNNER_ERROR_CODES.PATH_DENIED,
    );
  }
}

/** Enforce policy for a process.spawn; returns the sanitized env to use. */
export function enforceSpawnPolicy(
  config: RunnerConfig,
  opts: { binary: string; args: string[]; cwd?: string; env?: Record<string, string> },
): { env?: Record<string, string> } {
  assertIsolationSupported(config);
  assertCwdAllowed(config, opts.cwd);
  assertBinaryAllowed(config, opts.binary);
  assertCommandAllowed(config, [opts.binary, ...opts.args].join(' '));
  return { env: sanitizeEnv(opts.env) };
}

/**
 * Enforce policy for a shell.exec; returns the sanitized env to use.
 *
 * `cwd` is where the command will run. It is held to `allowedCwdRoots`
 * exactly as a spawn's is: this used to check the command and env only,
 * so shell.exec ran wherever the daemon happened to be started, whatever
 * roots the config listed.
 */
export function enforceShellPolicy(
  config: RunnerConfig,
  cmd: string,
  env?: Record<string, string>,
  cwd?: string,
): { env?: Record<string, string> } {
  assertIsolationSupported(config);
  assertCwdAllowed(config, cwd);
  assertCommandAllowed(config, cmd);
  assertShellBinariesAllowed(config, cmd);
  return { env: sanitizeEnv(env) };
}

/**
 * Enforce policy for a workspace folder the runner is asked to make
 * (`workspace.prepare`). The folder is held to `allowedCwdRoots` like any
 * cwd, and a runner that refuses every command (container isolation,
 * networkBlocked) refuses the folder too rather than making one nothing
 * can run in.
 */
export function enforceWorkspaceFolderPolicy(config: RunnerConfig, dir: string): void {
  assertIsolationSupported(config);
  assertCwdAllowed(config, dir);
}