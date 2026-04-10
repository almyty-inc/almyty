/**
 * CLI smoke tests — exercises every CLI command against a real backend.
 *
 * Gated behind RUN_CLI_SMOKE=1, same pattern as the backend's
 * RUN_DB_INTEGRATION=1 gate for real-Postgres integration specs.
 *
 * Prerequisites:
 *   1. All CLI packages built (npx tsc in each package dir)
 *   2. ~/.almyty/credentials.json with a valid token
 *   3. At least one gateway with tools on the target backend
 *
 * Run:
 *   cd packages/cli-tests
 *   RUN_CLI_SMOKE=1 npx vitest run
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync, ExecFileSyncOptions } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const GATED = !process.env.RUN_CLI_SMOKE;
const ROOT = resolve(import.meta.dirname, '../..');

function bin(pkg: string): string {
  return join(ROOT, 'packages', pkg, 'dist', 'index.js');
}

function run(pkg: string, args: string[], opts?: ExecFileSyncOptions): string {
  return execFileSync('node', [bin(pkg), ...args], {
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function runOrFail(pkg: string, args: string[]): { stdout: string; exitCode: number } {
  try {
    return { stdout: run(pkg, args), exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || '') + (err.stderr || ''), exitCode: err.status ?? 1 };
  }
}

describe.skipIf(GATED)('CLI smoke tests (RUN_CLI_SMOKE=1)', () => {
  beforeAll(() => {
    // Verify binaries exist
    for (const pkg of ['auth-cli', 'agents-cli', 'chat-cli', 'skills-cli', 'mcp-server', 'almyty-cli']) {
      if (!existsSync(bin(pkg))) {
        throw new Error(`${pkg} not built. Run: cd packages/${pkg} && npx tsc`);
      }
    }
  });

  // ---- auth-cli ----

  describe('auth-cli', () => {
    it('--version prints a semver', () => {
      expect(run('auth-cli', ['--version'])).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('--help prints usage', () => {
      const out = run('auth-cli', ['--help']);
      expect(out).toContain('login');
      expect(out).toContain('logout');
      expect(out).toContain('whoami');
    });

    it('whoami succeeds when authenticated', () => {
      const out = run('auth-cli', ['whoami']);
      expect(out).toContain('API:');
      expect(out).toContain('Token:');
    });
  });

  // ---- agents-cli ----

  describe('agents-cli', () => {
    it('--version prints a semver', () => {
      expect(run('agents-cli', ['--version'])).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('list returns JSON array', () => {
      const out = run('agents-cli', ['list', '--json']);
      expect(() => JSON.parse(out)).not.toThrow();
      expect(Array.isArray(JSON.parse(out))).toBe(true);
    });

    it('get nonexistent agent exits 1', () => {
      const { exitCode } = runOrFail('agents-cli', ['get', 'nonexistent-agent-xyz']);
      expect(exitCode).toBe(1);
    });
  });

  // ---- skills-cli ----

  describe('skills-cli', () => {
    it('--version prints a semver', () => {
      expect(run('skills-cli', ['--version'])).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('gateways lists at least one gateway', () => {
      const out = run('skills-cli', ['gateways']);
      expect(out).toContain('Your gateways:');
    });

    it('list shows available skills', () => {
      const out = run('skills-cli', ['list']);
      expect(out).toContain('skills available');
    });

    it('install + installed + remove round-trip', () => {
      // Parse a gateway ref from list output
      const listOut = run('skills-cli', ['list']);
      const refMatch = listOut.match(/@[^\s]+/);
      if (!refMatch) {
        console.warn('No skill refs found, skipping install round-trip');
        return;
      }
      // Strip to @org/gateway
      const gatewayRef = refMatch[0].replace(/\/[^/]+$/, '');

      const tmpDir = join(tmpdir(), `almyty-smoke-${Date.now()}`);
      mkdirSync(join(tmpDir, '.claude'), { recursive: true });

      try {
        // Install
        const installOut = run('skills-cli', ['install', gatewayRef, '--dir', tmpDir]);
        expect(installOut).toContain('Installed');

        // Verify installed
        const installedOut = run('skills-cli', ['installed', '--dir', tmpDir]);
        expect(installedOut).not.toContain('No almyty skills installed');

        // Remove
        const removeOut = run('skills-cli', ['remove', '--dir', tmpDir]);
        expect(removeOut).toContain('Removed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ---- chat-cli ----

  describe('chat-cli', () => {
    it('--version prints a semver', () => {
      expect(run('chat-cli', ['--version'])).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('--help prints usage', () => {
      const out = run('chat-cli', ['--help']);
      expect(out).toContain('chat');
      expect(out).toContain('/quit');
    });
  });

  // ---- mcp-server ----

  describe('mcp-server', () => {
    it('--help prints configuration docs', () => {
      const out = run('mcp-server', ['--help']);
      expect(out).toContain('Skill-first');
      expect(out).toContain('ALMYTY_TOKEN');
    });

    it('starts and discovers tools', () => {
      // mcp-server prints tool count to stderr, then reads stdin.
      // With stdin piped to nothing, it exits after discovery.
      const result = spawnSync('node', [bin('mcp-server')], {
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const combined = (result.stdout || '') + (result.stderr || '');
      expect(combined).toMatch(/\d+ tools/);
    });
  });

  // ---- almyty-cli (umbrella) ----

  describe('almyty-cli', () => {
    it('--version prints a semver', () => {
      expect(run('almyty-cli', ['--version'])).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('delegates whoami to auth-cli', () => {
      const out = run('almyty-cli', ['whoami']);
      expect(out).toContain('API:');
    });

    it('delegates agents list', () => {
      const out = run('almyty-cli', ['agents', 'list']);
      // Either "No agents found" or a list — both are valid
      expect(out.length).toBeGreaterThan(0);
    });

    it('unknown command exits 1', () => {
      const { exitCode } = runOrFail('almyty-cli', ['nonexistent-cmd']);
      expect(exitCode).toBe(1);
    });
  });
});
