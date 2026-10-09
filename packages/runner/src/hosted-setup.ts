/**
 * First start of a hosted workspace: clone the environment's repository
 * and run its setup script, once per environment version.
 *
 * Runs in enroll mode after the runner has its credential and before it
 * opens its stream, so the machine reports ready only once the checkout
 * and setup are in place (docs/hosted-runners.md, "Images and enroll
 * mode"). The design's rule: on the first start of a volume, or when the
 * environment version changed, clone `repo` at `ref`, run `setupScript`,
 * and write `<workspace>/.almyty/env-version`.
 *
 * The inputs are the plain variables the Deployment sets
 * (ALMYTY_WORKSPACE_ROOT, ALMYTY_ENVIRONMENT_VERSION, ALMYTY_REPO_URL,
 * ALMYTY_REPO_REF, ALMYTY_SETUP_SCRIPT) and one from the Secret,
 * ALMYTY_GIT_TOKEN. The git token reaches git through GIT_CONFIG_*
 * variables of that one child process: never on its command line, never
 * in a file, never in the clone's remote URL.
 *
 * A failed clone or setup is reported and the version is not recorded, so
 * the next start tries again; the runner still comes online, so the
 * person can look at what went wrong from a shell instead of watching a
 * pod restart in a loop.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the volume is mounted when the Deployment does not say. */
export const DEFAULT_WORKSPACE_ROOT = '/workspace';
/** The checkout's folder inside the workspace. */
export const REPO_DIR_NAME = 'repo';
/** A setup script running longer than this is stopped. Override: ALMYTY_SETUP_TIMEOUT_SECONDS. */
const DEFAULT_SETUP_TIMEOUT_SECONDS = 1800;

export interface CommandResult {
  code: number | null;
  timedOut?: boolean;
}

/** Runs one command with its output going to the runner's log. */
export type RunCommand = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

export interface PrepareInputs {
  env?: Record<string, string | undefined>;
  run?: RunCommand;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Where the script file is written before it runs. */
  tmpDir?: string;
}

export interface PrepareOutcome {
  /** Nothing to do: this volume already carries this environment version. */
  upToDate: boolean;
  cloned: boolean;
  setupRan: boolean;
  /** Clone and setup both succeeded (or were not needed) and the version was recorded. */
  ok: boolean;
  repoDir: string | null;
}

export function workspaceRoot(env: Record<string, string | undefined>): string {
  const root = (env.ALMYTY_WORKSPACE_ROOT ?? '').trim();
  return root.startsWith('/') ? root : DEFAULT_WORKSPACE_ROOT;
}

export async function prepareHostedWorkspace(inputs: PrepareInputs = {}): Promise<PrepareOutcome> {
  const env = inputs.env ?? process.env;
  const run = inputs.run ?? runCommand;
  const log = inputs.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const warn = inputs.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const root = workspaceRoot(env);
  const stateDir = join(root, '.almyty');
  const versionFile = join(stateDir, 'env-version');
  const version = (env.ALMYTY_ENVIRONMENT_VERSION ?? '').trim() || 'unversioned';
  const repoUrl = (env.ALMYTY_REPO_URL ?? '').trim();
  const repoDir = join(root, REPO_DIR_NAME);


  // An inherited workspace is kept read-only for its new owner to copy
  // from (the volume is mounted read-only): nothing is set up in it.
  if ((env.ALMYTY_WORKSPACE_READ_ONLY ?? '').trim() === 'true') {
    log('workspace: read-only (inherited); nothing is set up');
    return { upToDate: true, cloned: false, setupRan: false, ok: true, repoDir: repoUrl && existsSync(repoDir) ? repoDir : null };
  }
  const recorded = existsSync(versionFile) ? readFileSync(versionFile, 'utf-8').trim() : null;
  if (recorded === version) {
    log(`workspace: environment version ${version} already set up`);
    return { upToDate: true, cloned: false, setupRan: false, ok: true, repoDir: repoUrl ? repoDir : null };
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  // A spawned step gets the runner's own variables (the environment's
  // bindings among them); the enrollment token is already gone (enroll.ts).
  const childEnv: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  let ok = true;
  let cloned = false;

  if (repoUrl) {
    if (existsSync(join(repoDir, '.git'))) {
      // An existing checkout is the person's work; a new version does not
      // overwrite it. Only the setup script runs again.
      log(`workspace: ${repoDir} already holds a checkout; leaving it as it is`);
    } else {
      const result = await cloneRepo({ url: repoUrl, ref: (env.ALMYTY_REPO_REF ?? '').trim(), dir: repoDir, token: env.ALMYTY_GIT_TOKEN, env: childEnv, cwd: root, run, log });
      cloned = result;
      if (!result) {
        ok = false;
        warn(`workspace: cloning ${redactUrl(repoUrl)} failed; it is tried again on the next start`);
      }
    }
  }

  const script = env.ALMYTY_SETUP_SCRIPT ?? '';
  let setupRan = false;
  if (script.trim() && ok) {
    setupRan = true;
    const tmp = inputs.tmpDir ?? '/tmp';
    const file = join(tmp, `almyty-setup-${process.pid}-${Date.now()}.sh`);
    writeFileSync(file, script, { mode: 0o700 });
    const cwd = repoUrl && existsSync(repoDir) ? repoDir : root;
    const timeoutS = positiveInt(env.ALMYTY_SETUP_TIMEOUT_SECONDS) ?? DEFAULT_SETUP_TIMEOUT_SECONDS;
    log(`workspace: running the setup script in ${cwd}`);
    try {
      const res = await run('bash', [file], { cwd, env: childEnv, timeoutMs: timeoutS * 1000 });
      if (res.code !== 0) {
        ok = false;
        warn(res.timedOut
          ? `workspace: the setup script ran past ${timeoutS}s and was stopped; it runs again on the next start`
          : `workspace: the setup script exited ${res.code}; it runs again on the next start`);
      }
    } finally {
      rmSync(file, { force: true });
    }
  }

  if (ok) {
    writeFileSync(versionFile, `${version}\n`, { mode: 0o600 });
    log(`workspace: environment version ${version} set up`);
  }
  return { upToDate: false, cloned, setupRan, ok, repoDir: repoUrl ? repoDir : null };
}

async function cloneRepo(o: {
  url: string;
  ref: string;
  dir: string;
  token?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  run: RunCommand;
  log: (line: string) => void;
}): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...o.env, ...gitAuthEnv(o.url, o.token, o.env) };
  o.log(`workspace: cloning ${redactUrl(o.url)}${o.ref ? ` at ${o.ref}` : ''} into ${o.dir}`);
  const clone = await o.run('git', ['clone', '--', o.url, o.dir], { cwd: o.cwd, env });
  if (clone.code !== 0) {
    rmSync(o.dir, { recursive: true, force: true });
    return false;
  }
  if (!o.ref) return true;
  // A branch or tag checks out directly; a commit or another ref may need
  // fetching first.
  const checkout = await o.run('git', ['-C', o.dir, 'checkout', o.ref, '--'], { cwd: o.cwd, env });
  if (checkout.code === 0) return true;
  const fetch = await o.run('git', ['-C', o.dir, 'fetch', 'origin', o.ref], { cwd: o.cwd, env });
  if (fetch.code !== 0) return false;
  const detached = await o.run('git', ['-C', o.dir, 'checkout', 'FETCH_HEAD', '--'], { cwd: o.cwd, env });
  return detached.code === 0;
}

/**
 * The token as an HTTP Authorization header for the repository's origin,
 * passed through git's GIT_CONFIG_COUNT/KEY/VALUE variables (git 2.31+).
 * Empty for no token or a URL that is not https.
 */
export function gitAuthEnv(url: string, token: string | undefined, base: Record<string, string | undefined> = {}): Record<string, string> {
  if (!token) return {};
  let origin: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return {};
    origin = `${u.protocol}//${u.host}/`;
  } catch {
    return {};
  }
  const n = positiveInt(base.GIT_CONFIG_COUNT) ?? 0;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${origin}.extraHeader`,
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${basic}`,
  };
}

/** A URL with any user:password part removed, for log lines. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//');
  }
}

function positiveInt(value: string | undefined): number | undefined {
  const n = Number((value ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The real runner: inherits stdout/stderr, so setup output lands in the pod log. */
export const runCommand: RunCommand = (command, args, opts) =>
  new Promise((resolve) => {
    // Its own process group, so a timeout stops everything it started,
    // not only the shell.
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }, opts.timeoutMs)
      : null;
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
