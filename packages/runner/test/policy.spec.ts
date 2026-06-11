import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { enforceSpawnPolicy, enforceShellPolicy, sanitizeEnv } from '../src/policy.js';
import { RunnerError, type RunnerConfig } from '../src/types.js';

const base = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
  defaultIsolation: 'host',
  maxConcurrent: 4,
  allowedCwdRoots: [],
  denyPatterns: [],
  networkBlocked: false,
  installBlocked: false,
  ...over,
});

const spawn = (cfg: RunnerConfig, binary: string, args: string[] = [], cwd?: string, env?: Record<string, string>) =>
  enforceSpawnPolicy(cfg, { binary, args, cwd, env });

describe('runner policy enforcement', () => {
  describe('isolation fail-closed', () => {
    it('refuses to run when container isolation is configured (unimplemented)', () => {
      expect(() => spawn(base({ defaultIsolation: 'container' }), 'ls')).toThrow(/container isolation/i);
      expect(() => enforceShellPolicy(base({ defaultIsolation: 'container' }), 'ls')).toThrow(/container isolation/i);
    });

    it('refuses when networkBlocked is requested (cannot enforce on host)', () => {
      expect(() => spawn(base({ networkBlocked: true }), 'ls')).toThrow(/networkBlocked/);
    });

    it('allows host isolation with no restrictions', () => {
      expect(() => spawn(base(), 'ls', ['-la'])).not.toThrow();
    });
  });

  describe('denyPatterns', () => {
    it('blocks a binary/arg matching a deny pattern (regex)', () => {
      expect(() => spawn(base({ denyPatterns: ['rm\\s+-rf'] }), 'rm', ['-rf', '/'])).toThrow(/denyPattern/);
    });
    it('treats an invalid regex pattern as a literal substring (still denies)', () => {
      expect(() => spawn(base({ denyPatterns: ['('] }), 'echo', ['(']))
        .toThrow(/denyPattern/);
    });
    it('allows commands that match nothing', () => {
      expect(() => spawn(base({ denyPatterns: ['curl'] }), 'echo', ['hi'])).not.toThrow();
    });
  });

  describe('installBlocked', () => {
    it.each(['npm install left-pad', 'pip3 install requests', 'apt-get install curl', 'cargo install ripgrep'])(
      'blocks install command: %s',
      (cmd) => {
        expect(() => enforceShellPolicy(base({ installBlocked: true }), cmd)).toThrow(/installation is blocked/i);
      },
    );
    it('allows installs when installBlocked is false', () => {
      expect(() => enforceShellPolicy(base({ installBlocked: false }), 'npm install x')).not.toThrow();
    });
  });

  describe('allowedCwdRoots', () => {
    it('rejects a cwd outside the allowed roots', () => {
      const root = mkdtempSync(join(tmpdir(), 'runner-cwd-'));
      try {
        expect(() => spawn(base({ allowedCwdRoots: [join(root, 'allowed')] }), 'ls', [], join(root, 'elsewhere')))
          .toThrow(/allowedCwdRoots/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it('allows a cwd inside an allowed root', () => {
      const root = mkdtempSync(join(tmpdir(), 'runner-cwd-'));
      const allowed = join(root, 'allowed');
      mkdirSync(allowed, { recursive: true });
      try {
        expect(() => spawn(base({ allowedCwdRoots: [allowed] }), 'ls', [], allowed)).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it('requires a cwd when roots are configured', () => {
      expect(() => spawn(base({ allowedCwdRoots: ['/tmp/x'] }), 'ls')).toThrow(/cwd is required/);
    });
  });

  describe('env sanitization', () => {
    it('strips dangerous keys but keeps the rest', () => {
      const out = sanitizeEnv({ PATH: '/evil', LD_PRELOAD: '/x.so', NODE_OPTIONS: '--x', MY_VAR: 'ok' });
      expect(out).toEqual({ MY_VAR: 'ok' });
    });
    it('returns the sanitized env from enforceSpawnPolicy', () => {
      const { env } = spawn(base(), 'node', [], undefined, { PATH: '/evil', SAFE: '1' });
      expect(env).toEqual({ SAFE: '1' });
    });
    it('is case-insensitive on key names', () => {
      expect(sanitizeEnv({ path: '/evil', Ld_Preload: 'x' })).toEqual({});
    });
  });

  it('throws RunnerError (typed) on violations', () => {
    try {
      spawn(base({ defaultIsolation: 'container' }), 'ls');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RunnerError);
    }
  });
});
