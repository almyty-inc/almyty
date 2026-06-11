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
  assertCommandAllowed(config, [opts.binary, ...opts.args].join(' '));
  return { env: sanitizeEnv(opts.env) };
}

/** Enforce policy for a shell.exec; returns the sanitized env to use. */
export function enforceShellPolicy(
  config: RunnerConfig,
  cmd: string,
  env?: Record<string, string>,
): { env?: Record<string, string> } {
  assertIsolationSupported(config);
  assertCommandAllowed(config, cmd);
  return { env: sanitizeEnv(env) };
}
