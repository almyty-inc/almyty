import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { gitAuthEnv, prepareHostedWorkspace, redactUrl, RunCommand, runCommand } from '../src/hosted-setup.js';

let root: string;
let tmp: string;
const quiet = { log: () => {}, warn: () => {} };
const execFileAsync = promisify(execFile);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-ws-'));
  tmp = mkdtempSync(join(tmpdir(), 'hosted-tmp-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

const versionFile = () => join(root, '.almyty', 'env-version');

describe('prepareHostedWorkspace: the setup script', () => {
  it('runs once per environment version and records the version', async () => {
    const env = {
      ALMYTY_WORKSPACE_ROOT: root,
      ALMYTY_ENVIRONMENT_VERSION: '3',
      ALMYTY_SETUP_SCRIPT: 'echo ran >> setup-runs.txt\necho "$MY_BINDING" > binding.txt\n',
      MY_BINDING: 'from-the-secret',
    };
    const first = await prepareHostedWorkspace({ env, tmpDir: tmp, ...quiet });
    expect(first).toMatchObject({ upToDate: false, setupRan: true, ok: true, repoDir: null });
    expect(readFileSync(versionFile(), 'utf-8').trim()).toBe('3');
    expect(readFileSync(join(root, 'binding.txt'), 'utf-8').trim()).toBe('from-the-secret');
    // The script file itself does not linger in /tmp.
    expect(readdirSync(tmp)).toEqual([]);

    const second = await prepareHostedWorkspace({ env, tmpDir: tmp, ...quiet });
    expect(second).toMatchObject({ upToDate: true, setupRan: false });
    expect(readFileSync(join(root, 'setup-runs.txt'), 'utf-8')).toBe('ran\n');

    const bumped = await prepareHostedWorkspace({ env: { ...env, ALMYTY_ENVIRONMENT_VERSION: '4' }, tmpDir: tmp, ...quiet });
    expect(bumped.setupRan).toBe(true);
    expect(readFileSync(join(root, 'setup-runs.txt'), 'utf-8')).toBe('ran\nran\n');
    expect(readFileSync(versionFile(), 'utf-8').trim()).toBe('4');
  });

  it('does not record a version whose setup failed, so the next start tries again', async () => {
    const warn = vi.fn();
    const env = { ALMYTY_WORKSPACE_ROOT: root, ALMYTY_ENVIRONMENT_VERSION: '1', ALMYTY_SETUP_SCRIPT: 'exit 7' };
    const out = await prepareHostedWorkspace({ env, tmpDir: tmp, log: () => {}, warn });
    expect(out.ok).toBe(false);
    expect(existsSync(versionFile())).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/exited 7/));
  });

  it('stops a setup script that runs past its timeout', async () => {
    const warn = vi.fn();
    const env = { ALMYTY_WORKSPACE_ROOT: root, ALMYTY_SETUP_SCRIPT: 'sleep 1', ALMYTY_SETUP_TIMEOUT_SECONDS: '1' };
    const run: RunCommand = (cmd, args, opts) => runCommand(cmd, args, { ...opts, timeoutMs: 50 });
    const out = await prepareHostedWorkspace({ env, tmpDir: tmp, run, log: () => {}, warn });
    expect(out.ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ran past 1s/));
  });

  it('records the version with nothing to do', async () => {
    const out = await prepareHostedWorkspace({ env: { ALMYTY_WORKSPACE_ROOT: root, ALMYTY_ENVIRONMENT_VERSION: '9' }, tmpDir: tmp, ...quiet });
    expect(out).toMatchObject({ ok: true, setupRan: false, cloned: false });
    expect(readFileSync(versionFile(), 'utf-8').trim()).toBe('9');
  });
});

describe('prepareHostedWorkspace: the repository', () => {
  // Real git, run the way the daemon runs it (with the process's PATH), but
  // with nothing from the person running the tests: its own HOME and global
  // config, no system config, no signing, no hooks, no credential helper.
  // Without PATH the spawn falls back to /usr/bin, which on macOS is the
  // xcrun shim and costs seconds per call; with the user's config a signing
  // key or hook could prompt or fail the commit.
  function isolatedGitEnv(): NodeJS.ProcessEnv {
    const home = join(tmp, 'home');
    mkdirSync(home);
    const config = join(home, '.gitconfig');
    writeFileSync(config, [
      '[user]', '\tname = t', '\temail = t@example.com',
      '[commit]', '\tgpgsign = false',
      '[tag]', '\tgpgsign = false',
      '[init]', '\tdefaultBranch = main',
      '[core]', `\thooksPath = ${join(home, 'no-hooks')}`, '\tfsmonitor = false',
      '[credential]', '\thelper =',
      '',
    ].join('\n'));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    return env;
  }

  function gitWithInput(cwd: string, env: NodeJS.ProcessEnv, args: string[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', args, { cwd, env }, (err) => (err ? reject(err) : resolve()));
      child.stdin!.end(input);
    });
  }

  it('clones a real repository at its ref into <workspace>/repo and runs setup inside it', async () => {
    const gitEnv = isolatedGitEnv();
    const origin = join(tmp, 'origin');
    mkdirSync(origin);
    // Two git processes instead of one per commit: `main` and `feature`
    // written in one fast-import stream. Each spawn costs seconds on a
    // loaded Mac, and fast-import runs no hooks and signs nothing.
    // Asynchronous, so a slow machine meets the test timeout instead of
    // blocking the test runner's clock.
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: origin, env: gitEnv });
    const who = 't <t@example.com> 1700000000 +0000';
    const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}`;
    await gitWithInput(origin, gitEnv, ['fast-import', '--quiet'], [
      'commit refs/heads/main', `author ${who}`, `committer ${who}`, data('one'), 'M 100644 inline README.md', data('main\n'),
      'commit refs/heads/feature', `author ${who}`, `committer ${who}`, data('two'), 'from refs/heads/main', 'M 100644 inline README.md', data('feature\n'),
      '',
    ].join('\n'));

    const env = {
      ...gitEnv,
      ALMYTY_WORKSPACE_ROOT: root,
      ALMYTY_ENVIRONMENT_VERSION: '1',
      ALMYTY_REPO_URL: origin,
      ALMYTY_REPO_REF: 'feature',
      ALMYTY_SETUP_SCRIPT: 'cat README.md > ../seen.txt',
    };
    const out = await prepareHostedWorkspace({ env, tmpDir: join(tmp), ...quiet });
    expect(out).toMatchObject({ cloned: true, setupRan: true, ok: true, repoDir: join(root, 'repo') });
    expect(readFileSync(join(root, 'repo', 'README.md'), 'utf-8')).toBe('feature\n');
    expect(readFileSync(join(root, 'seen.txt'), 'utf-8')).toBe('feature\n');

    // A new version leaves the person's checkout alone and only re-runs setup.
    writeFileSync(join(root, 'repo', 'README.md'), 'edited\n');
    const again = await prepareHostedWorkspace({ env: { ...env, ALMYTY_ENVIRONMENT_VERSION: '2' }, tmpDir: tmp, ...quiet });
    expect(again).toMatchObject({ cloned: false, setupRan: true, ok: true });
    expect(readFileSync(join(root, 'repo', 'README.md'), 'utf-8')).toBe('edited\n');
    // Four real processes for the clone; on a loaded machine each can take seconds.
  }, 60_000);

  it('hands the git token to git through GIT_CONFIG_* variables, never on the command line', async () => {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run: RunCommand = async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env });
      if (args[0] === 'clone') mkdirSync(join(args[3], '.git'), { recursive: true });
      return { code: 0 };
    };
    const token = 'fake-git-token-for-tests';
    const env = { ALMYTY_WORKSPACE_ROOT: root, ALMYTY_REPO_URL: 'https://github.com/acme/app.git', ALMYTY_GIT_TOKEN: token };
    const out = await prepareHostedWorkspace({ env, run, tmpDir: tmp, ...quiet });
    expect(out.cloned).toBe(true);
    const clone = calls[0];
    expect(clone.cmd).toBe('git');
    expect(clone.args).toEqual(['clone', '--', 'https://github.com/acme/app.git', join(root, 'repo')]);
    expect(clone.args.join(' ')).not.toContain(token);
    expect(clone.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(Buffer.from(String(clone.env.GIT_CONFIG_VALUE_0).replace('Authorization: Basic ', ''), 'base64').toString()).toBe(`x-access-token:${token}`);
    expect(clone.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('removes a half-made clone and reports the failure without the URL credentials', async () => {
    const warn = vi.fn();
    const run: RunCommand = async (_cmd, args) => {
      if (args[0] === 'clone') mkdirSync(join(args[3], 'partial'), { recursive: true });
      return { code: 128 };
    };
    const env = { ALMYTY_WORKSPACE_ROOT: root, ALMYTY_REPO_URL: 'https://user:secret-pass@git.example.com/r.git', ALMYTY_SETUP_SCRIPT: 'touch should-not-run' };
    const out = await prepareHostedWorkspace({ env, run, tmpDir: tmp, log: () => {}, warn });
    expect(out).toMatchObject({ ok: false, cloned: false, setupRan: false });
    expect(existsSync(join(root, 'repo'))).toBe(false);
    expect(existsSync(versionFile())).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-pass');
  });
});

describe('helpers', () => {
  it('gitAuthEnv: https only, and appends to existing GIT_CONFIG_* entries', () => {
    expect(gitAuthEnv('git@github.com:a/b.git', 't')).toEqual({});
    expect(gitAuthEnv('https://github.com/a/b', undefined)).toEqual({});
    expect(gitAuthEnv('https://gitlab.example:8443/a/b', 't', { GIT_CONFIG_COUNT: '2' })).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'http.https://gitlab.example:8443/.extraHeader',
    });
  });

  it('redactUrl drops user and password', () => {
    expect(redactUrl('https://u:p@host/x.git')).toBe('https://host/x.git');
    expect(redactUrl('https://host/x.git')).toBe('https://host/x.git');
  });
});
