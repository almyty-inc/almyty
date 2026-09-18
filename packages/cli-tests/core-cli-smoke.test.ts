/**
 * Smoke tests for the four core CLIs: @almyty/cli, @almyty/auth,
 * @almyty/agents and @almyty/skills.
 *
 * Separate from cli-smoke.test.ts, which covers chat, mcp-server,
 * models and connections. The split is deliberate: these four share a
 * set of conventions (one exit-code table, --json on every read
 * command, --flag=value parsing, version read from package.json) and
 * the first describe block asserts those conventions across all four
 * at once.
 *
 * Gated behind RUN_CLI_SMOKE=1, same pattern as the backend's
 * RUN_DB_INTEGRATION=1 gate for real-Postgres integration specs.
 *
 * Prerequisites:
 *   1. All CLI packages built (npx tsc in each package dir)
 *   2. ~/.almyty/credentials.json with a valid token
 *   3. At least one gateway with tools on the target backend
 *
 * Nothing here logs in, and nothing writes to ~/.almyty — install tests
 * write into a temp project directory and clean up after themselves.
 *
 * Run:
 *   cd packages/cli-tests
 *   RUN_CLI_SMOKE=1 npx vitest run
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, ExecFileSyncOptions } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const GATED = !process.env.RUN_CLI_SMOKE;
const ROOT = resolve(import.meta.dirname, '../..');

/** The shared exit-code table every almyty CLI uses. */
const EXIT = { OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, NOT_FOUND: 4, FAILED: 5 } as const;

function bin(pkg: string): string {
  return join(ROOT, 'packages', pkg, 'dist', 'index.js');
}

function pkgVersion(pkg: string): string {
  return JSON.parse(
    readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf-8'),
  ).version;
}

function run(pkg: string, args: string[], opts?: ExecFileSyncOptions): string {
  return execFileSync('node', [bin(pkg), ...args], {
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function runOrFail(
  pkg: string,
  args: string[],
  opts?: ExecFileSyncOptions,
): { stdout: string; exitCode: number } {
  try {
    return { stdout: run(pkg, args, opts), exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || '') + (err.stderr || ''), exitCode: err.status ?? 1 };
  }
}

/** A HOME with no credentials file, so the auth path can be exercised. */
function unauthenticatedEnv(): NodeJS.ProcessEnv {
  const home = join(tmpdir(), `almyty-nohome-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ALMYTY_TOKEN;
  return env;
}

describe.skipIf(GATED)('core CLI smoke tests (RUN_CLI_SMOKE=1)', () => {
  beforeAll(() => {
    // Verify binaries exist
    for (const pkg of ['auth-cli', 'agents-cli', 'skills-cli', 'almyty-cli']) {
      if (!existsSync(bin(pkg))) {
        throw new Error(`${pkg} not built. Run: cd packages/${pkg} && npx tsc`);
      }
    }
  });

  // ---- conventions shared by every CLI ----

  describe('suite-wide conventions', () => {
    it.each(['auth-cli', 'agents-cli', 'skills-cli', 'almyty-cli'])(
      '%s --version agrees with its package.json',
      (pkg) => {
        // Every CLI hardcoded a VERSION string that had drifted: the
        // three at 0.1.0 and skills at 1.0.12, against a published 1.2.0.
        expect(run(pkg, ['--version'])).toBe(pkgVersion(pkg));
      },
    );

    it.each(['auth-cli', 'agents-cli', 'skills-cli'])(
      '%s exits 3, not 1, when there is no credential',
      (pkg) => {
        const command = pkg === 'auth-cli' ? ['whoami'] : ['list'];
        const { exitCode } = runOrFail(pkg, command, { env: unauthenticatedEnv() });
        expect(exitCode).toBe(EXIT.AUTH);
      },
    );

    it.each(['auth-cli', 'agents-cli', 'skills-cli', 'almyty-cli'])(
      '%s exits 2 for an unknown command',
      (pkg) => {
        const { exitCode, stdout } = runOrFail(pkg, ['definitely-not-a-command']);
        expect(exitCode).toBe(EXIT.USAGE);
        expect(stdout).toContain('Unknown command');
      },
    );

    it.each(['auth-cli', 'agents-cli', 'skills-cli', 'almyty-cli'])(
      '%s --help documents the exit codes',
      (pkg) => {
        expect(run(pkg, ['--help'])).toContain('Exit codes');
      },
    );

    it.each(['auth-cli', 'agents-cli', 'skills-cli'])(
      '%s accepts --flag=value as well as --flag value',
      (pkg) => {
        // `--url=https://x` used to become a flag literally named
        // "url=https://x", and the value was silently dropped.
        const { exitCode } = runOrFail(pkg, ['--version']);
        expect(exitCode).toBe(EXIT.OK);
        const env = unauthenticatedEnv();
        const spaced = runOrFail(pkg, pkg === 'auth-cli'
          ? ['whoami', '--json']
          : ['list', '--url', 'https://api.almyty.com', '--json'], { env });
        const equalsForm = runOrFail(pkg, pkg === 'auth-cli'
          ? ['whoami', '--json=1']
          : ['list', '--url=https://api.almyty.com', '--json'], { env });
        // Both forms reach the same place: unauthenticated, exit 3.
        expect(equalsForm.exitCode).toBe(spaced.exitCode);
      },
    );
  });

  // ---- auth-cli ----

  describe('auth-cli', () => {
    it('--help prints usage', () => {
      const out = run('auth-cli', ['--help']);
      expect(out).toContain('login');
      expect(out).toContain('logout');
      expect(out).toContain('whoami');
      expect(out).toContain('--verify');
    });

    it('whoami succeeds when authenticated', () => {
      const out = run('auth-cli', ['whoami']);
      expect(out).toContain('API:');
      expect(out).toContain('Token:');
      expect(out).toContain('Expiry:');
    });

    it('whoami --json emits parseable output with no token in it', () => {
      const parsed = JSON.parse(run('auth-cli', ['whoami', '--json']));
      expect(parsed.authenticated).toBe(true);
      expect(parsed.tokenPreview).toBeTruthy();
      expect(parsed.token).toBeUndefined();
    });

    it('whoami --verify confirms the token against the API', () => {
      const parsed = JSON.parse(run('auth-cli', ['whoami', '--json', '--verify']));
      expect(parsed.verified?.ok).toBe(true);
    });

    it('login --token "" is a usage error, not a crash', () => {
      // `cmdLogin` called require('./config') in an ESM package, so
      // every login died with "require is not defined" before printing
      // anything. This reaches the argument guard, which proves the
      // module graph loads.
      const { exitCode, stdout } = runOrFail('auth-cli', ['login', '--token', '']);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stdout).not.toContain('require is not defined');
      expect(stdout).not.toContain('ERR_MODULE_NOT_FOUND');
    });

    it('login refuses a plaintext remote API URL', () => {
      const { exitCode, stdout } = runOrFail('auth-cli', [
        'login',
        '--api',
        'http://api.example.com',
        '--token',
        'x',
      ]);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stdout).toContain('insecure');
    });
  });

  // ---- agents-cli ----

  describe('agents-cli', () => {
    it('list returns a JSON array', () => {
      const out = run('agents-cli', ['list', '--json']);
      expect(Array.isArray(JSON.parse(out))).toBe(true);
    });

    it('get nonexistent agent exits 4 (not found), not 1', () => {
      const { exitCode } = runOrFail('agents-cli', ['get', 'nonexistent-agent-xyz']);
      expect(exitCode).toBe(EXIT.NOT_FOUND);
    });

    it('inspect with no runId is a usage error', () => {
      const { exitCode } = runOrFail('agents-cli', ['inspect']);
      expect(exitCode).toBe(EXIT.USAGE);
    });

    it('--help documents runs, inspect, executions and trace', () => {
      const out = run('agents-cli', ['--help']);
      for (const command of ['runs', 'inspect', 'executions', 'trace']) {
        expect(out).toContain(command);
      }
    });

    it('runs --json is parseable and paginated', () => {
      const agents = JSON.parse(run('agents-cli', ['list', '--json'])) as any[];
      const agent = agents.find((a) => a.mode === 'autonomous') ?? agents[0];
      if (!agent) return;
      const parsed = JSON.parse(run('agents-cli', ['runs', agent.id, '--json', '--limit', '5']));
      expect(parsed).toHaveProperty('total');
      expect(Array.isArray(parsed.data)).toBe(true);
      expect(parsed.limit).toBe(5);
    });

    it('executions --json is parseable', () => {
      const agents = JSON.parse(run('agents-cli', ['list', '--json'])) as any[];
      const agent = agents.find((a) => a.mode !== 'autonomous') ?? agents[0];
      if (!agent) return;
      const parsed = JSON.parse(run('agents-cli', ['executions', agent.id, '--json']));
      expect(Array.isArray(parsed.data)).toBe(true);
    });

    it('running a non-active agent says to activate it, not the API body', () => {
      const agents = JSON.parse(run('agents-cli', ['list', '--json'])) as any[];
      const draft = agents.find((a) => a.status && a.status.toLowerCase() !== 'active');
      if (!draft) return;
      const { exitCode, stdout } = runOrFail('agents-cli', ['run', draft.id]);
      expect(exitCode).toBe(EXIT.FAILED);
      expect(stdout).toContain('Activate it');
      expect(stdout).not.toContain('AGENT_NOT_ACTIVE');
      expect(stdout).not.toContain('API error 400');
    });
  });

  // ---- skills-cli ----

  describe('skills-cli', () => {
    it('gateways lists at least one gateway', () => {
      const out = run('skills-cli', ['gateways']);
      expect(out).toContain('Your gateways:');
    });

    it('gateways --json is parseable', () => {
      expect(Array.isArray(JSON.parse(run('skills-cli', ['gateways', '--json'])))).toBe(true);
    });

    it('list shows available skills', () => {
      const out = run('skills-cli', ['list']);
      expect(out).toContain('skills available');
    });

    it('list --json emits a ref for every skill', () => {
      const skills = JSON.parse(run('skills-cli', ['list', '--json'])) as any[];
      expect(Array.isArray(skills)).toBe(true);
      for (const skill of skills.slice(0, 5)) expect(skill.ref).toBeTruthy();
    });

    it('search --json is parseable', () => {
      expect(Array.isArray(JSON.parse(run('skills-cli', ['search', 'a', '--json'])))).toBe(true);
    });

    it('install --dry-run names the files and writes nothing', () => {
      // The old round-trip test grepped the human list output for
      // /@[^\s]+/, which that output never contains, so the whole
      // install check silently skipped. Take the ref from --json.
      const skills = JSON.parse(run('skills-cli', ['list', '--json'])) as any[];
      if (skills.length === 0) return;
      const gatewayRef = String(skills[0].ref).split('/').slice(0, 2).join('/');

      const tmpDir = join(tmpdir(), `almyty-smoke-${Date.now()}`);
      mkdirSync(join(tmpDir, '.claude'), { recursive: true });
      try {
        const dry = JSON.parse(
          run('skills-cli', ['install', gatewayRef, '--dir', tmpDir, '--dry-run', '--json']),
        );
        expect(dry.dryRun).toBe(true);
        expect(dry.targets.length).toBeGreaterThan(0);
        for (const target of dry.targets) {
          expect(target.files.length).toBe(target.installed);
          expect(existsSync(target.skillsDir)).toBe(false);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('install + installed + remove round-trip', () => {
      const skills = JSON.parse(run('skills-cli', ['list', '--json'])) as any[];
      if (skills.length === 0) return;
      const gatewayRef = String(skills[0].ref).split('/').slice(0, 2).join('/');

      const tmpDir = join(tmpdir(), `almyty-smoke-${Date.now()}`);
      mkdirSync(join(tmpDir, '.claude'), { recursive: true });

      try {
        const installed = JSON.parse(
          run('skills-cli', ['install', gatewayRef, '--dir', tmpDir, '--json']),
        );
        expect(installed.dryRun).toBe(false);
        const total = installed.targets.reduce((n: number, t: any) => n + t.installed, 0);
        expect(total).toBeGreaterThan(0);

        const listed = JSON.parse(run('skills-cli', ['installed', '--dir', tmpDir, '--json']));
        expect(listed.length).toBeGreaterThan(0);

        // Installing again over the same files must report the overwrite.
        const again = JSON.parse(
          run('skills-cli', ['install', gatewayRef, '--dir', tmpDir, '--json']),
        );
        const overwritten = again.targets.reduce((n: number, t: any) => n + t.overwritten, 0);
        expect(overwritten).toBeGreaterThan(0);

        const removed = JSON.parse(run('skills-cli', ['remove', '--dir', tmpDir, '--json']));
        expect(removed.removed).toBeGreaterThan(0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('an ambiguous bare ref exits 2 rather than guessing', () => {
      const { exitCode } = runOrFail('skills-cli', ['install', 'e', '--yes', '--dry-run']);
      // 2 for ambiguous, 4 for no match — either is a refusal, never 0.
      expect([EXIT.USAGE, EXIT.NOT_FOUND]).toContain(exitCode);
    });

    it('the old auth commands point at @almyty/auth and exit 2', () => {
      for (const command of ['login', 'logout', 'whoami']) {
        const { exitCode, stdout } = runOrFail('skills-cli', [command]);
        expect(exitCode).toBe(EXIT.USAGE);
        expect(stdout).toContain('@almyty/auth');
      }
    });
  });



  // ---- almyty-cli (umbrella) ----

  describe('almyty-cli', () => {
    it('bare invocation prints a short tour, not the full reference', () => {
      const out = run('almyty-cli', []);
      expect(out).toContain('almyty login');
      expect(out).toContain('almyty help');
      expect(out.split('\n').length).toBeLessThan(20);
    });

    it('help lists every routed command, models and connections included', () => {
      const out = run('almyty-cli', ['help']);
      for (const command of [
        'login', 'logout', 'whoami', 'auth', 'agents', 'chat',
        'skills', 'models', 'connections', 'runner', 'mcp', 'acp',
      ]) {
        expect(out, command).toContain(command);
      }
    });

    it('delegates whoami to auth-cli', () => {
      expect(run('almyty-cli', ['whoami'])).toContain('API:');
    });

    it('delegates agents list', () => {
      expect(run('almyty-cli', ['agents', 'list']).length).toBeGreaterThan(0);
    });

    it('forwards --help to the delegated package', () => {
      expect(run('almyty-cli', ['skills', '--help'])).toContain('@almyty/skills');
      expect(run('almyty-cli', ['agents', '--help'])).toContain('@almyty/agents');
    });

    it('propagates the delegate exit code, not a flattened 1', () => {
      const { exitCode } = runOrFail('almyty-cli', ['agents', 'get', 'nonexistent-agent-xyz']);
      expect(exitCode).toBe(EXIT.NOT_FOUND);
    });

    it('unknown command exits 2 and suggests the nearest real one', () => {
      const { exitCode, stdout } = runOrFail('almyty-cli', ['agent']);
      expect(exitCode).toBe(EXIT.USAGE);
      expect(stdout).toContain('Did you mean');
    });

    it.each(['bash', 'zsh', 'fish'])('emits a %s completion script', (shell) => {
      expect(run('almyty-cli', ['completion', shell])).toContain('almyty');
    });

    it('rejects an unsupported completion shell', () => {
      const { exitCode } = runOrFail('almyty-cli', ['completion', 'powershell']);
      expect(exitCode).toBe(EXIT.USAGE);
    });
  });
});
