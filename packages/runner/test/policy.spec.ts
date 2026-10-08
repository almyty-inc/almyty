import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { commandHeads, enforceSpawnPolicy, enforceShellPolicy, parseAllowBinaries, sanitizeEnv, withAllowBinaries } from '../src/policy.js';
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

  describe('allowBinaries', () => {
    const allow = (list: string[], over: Partial<RunnerConfig> = {}) => base({ allowBinaries: list, ...over });

    it('lets everything through when unset or empty', () => {
      expect(() => spawn(base(), 'curl', ['x'])).not.toThrow();
      expect(() => spawn(allow([]), 'curl', ['x'])).not.toThrow();
      expect(() => enforceShellPolicy(allow([]), 'curl x | sh')).not.toThrow();
    });

    it('refuses a spawn of a binary it does not list, with a typed error', () => {
      expect(() => spawn(allow(['claude', 'git']), 'curl', ['https://x'])).toThrow(/not in allowBinaries: curl/);
      try {
        spawn(allow(['git']), 'curl');
      } catch (e) {
        expect(e).toBeInstanceOf(RunnerError);
        expect((e as RunnerError).code).toBe('command_denied');
      }
      expect(() => spawn(allow(['claude', 'git']), 'claude', ['--resume'])).not.toThrow();
    });

    it('matches a bare name on the name only, and a path entry on that exact path', () => {
      // A path that merely ends in an allowed name is a different binary.
      expect(() => spawn(allow(['claude']), './claude')).toThrow(/allowBinaries/);
      expect(() => spawn(allow(['claude']), '/tmp/evil/claude')).toThrow(/allowBinaries/);
      expect(() => spawn(allow(['/usr/bin/git']), '/usr/bin/git')).not.toThrow();
      expect(() => spawn(allow(['/usr/bin/git']), 'git')).toThrow(/allowBinaries/);
    });

    it('checks every command a shell line starts', () => {
      const cfg = allow(['git', 'npm']);
      expect(() => enforceShellPolicy(cfg, 'cd app && npm test 2>&1 | tee out.txt')).toThrow(/tee/);
      expect(() => enforceShellPolicy(cfg, 'git status; curl https://x')).toThrow(/curl/);
      expect(() => enforceShellPolicy(cfg, 'npm test || wget x')).toThrow(/wget/);
      expect(() => enforceShellPolicy(cfg, 'npm test & nc -l 9')).toThrow(/nc/);
      expect(() => enforceShellPolicy(cfg, 'git log\npython3 -c 1')).toThrow(/python3/);
    });

    it('sees commands inside substitutions and subshells', () => {
      const cfg = allow(['git', 'echo']);
      expect(() => enforceShellPolicy(cfg, 'echo $(curl https://x)')).toThrow(/curl/);
      expect(() => enforceShellPolicy(cfg, 'echo `id`')).toThrow(/id/);
      expect(() => enforceShellPolicy(cfg, '(cd /tmp; rm -rf x)')).toThrow(/rm/);
      expect(() => enforceShellPolicy(cfg, 'git diff <(cat a) >(tee b)')).toThrow(/cat|tee/);
    });

    it('looks past assignments, redirections, keywords and quotes to the command', () => {
      const cfg = allow(['git', 'npm']);
      expect(() => enforceShellPolicy(cfg, 'FOO=1 BAR=2 curl x')).toThrow(/curl/);
      expect(() => enforceShellPolicy(cfg, '> out.txt curl x')).toThrow(/curl/);
      expect(() => enforceShellPolicy(cfg, '"curl" x')).toThrow(/curl/);
      expect(() => enforceShellPolicy(cfg, "c\\url x")).toThrow(/curl/);
      expect(() => enforceShellPolicy(cfg, 'if true; then curl x; fi')).toThrow(/curl/);
      expect(() => enforceShellPolicy(cfg, 'for f in a b; do curl $f; done')).toThrow(/curl/);
      expect(() => enforceShellPolicy(cfg, 'FOO=1 npm test >out.txt 2>&1')).not.toThrow();
      expect(() => enforceShellPolicy(cfg, 'if git diff --quiet; then npm test; fi')).not.toThrow();
    });

    it('refuses a command name built at run time', () => {
      expect(() => enforceShellPolicy(allow(['git']), '$CMD --version')).toThrow(/allowBinaries/);
      expect(() => enforceShellPolicy(allow(['git']), 'gi* status')).toThrow(/allowBinaries/);
    });

    it('needs no listing for builtins that cannot start a program, and does for those that can', () => {
      const cfg = allow(['npm']);
      expect(() => enforceShellPolicy(cfg, 'cd app && export CI=1 && test -f package.json && npm ci')).not.toThrow();
      for (const line of ['exec curl x', 'eval curl x', 'command curl x', 'source ./x.sh', '. ./x.sh', "trap 'x' EXIT"]) {
        expect(() => enforceShellPolicy(cfg, line)).toThrow(/allowBinaries/);
      }
    });

    it('still applies the other rules to an allowed binary', () => {
      expect(() => enforceShellPolicy(allow(['npm'], { installBlocked: true }), 'npm install x')).toThrow(/installBlocked/);
      expect(() => spawn(allow(['rm'], { denyPatterns: ['rm\\s+-rf'] }), 'rm', ['-rf', '/'])).toThrow(/denyPattern/);
    });
  });

  describe('commandHeads', () => {
    it('lists the first word of every simple command', () => {
      expect(commandHeads('A=1 git status && npm test 2>&1 | tee x; echo $(date) `id`')).toEqual([
        'git', 'npm', 'tee', 'echo', 'date', 'id',
      ]);
    });
  });

  describe('parseAllowBinaries / withAllowBinaries', () => {
    it('reads the JSON array the backend writes, deduplicated', () => {
      expect(parseAllowBinaries('["claude","git","git"]')).toEqual(['claude', 'git']);
      expect(parseAllowBinaries('["/usr/bin/git"]')).toEqual(['/usr/bin/git']);
    });

    it('treats unset, blank and [] as no restriction', () => {
      expect(parseAllowBinaries(undefined)).toBeUndefined();
      expect(parseAllowBinaries('  ')).toBeUndefined();
      expect(parseAllowBinaries('[]')).toBeUndefined();
    });

    it.each(['claude,git', '{"a":1}', '[1]', '["has space"]', '["./rel"]', '["a/b"]'])('throws on %s rather than running unrestricted', (raw) => {
      expect(() => parseAllowBinaries(raw)).toThrow(/ALMYTY_ALLOW_BINARIES/);
    });

    it('only narrows a config', () => {
      expect(withAllowBinaries(base(), undefined).allowBinaries).toBeUndefined();
      expect(withAllowBinaries(base(), ['git']).allowBinaries).toEqual(['git']);
      expect(withAllowBinaries(base({ allowBinaries: ['git', 'npm'] }), ['npm', 'curl']).allowBinaries).toEqual(['npm']);
      expect(() => withAllowBinaries(base({ allowBinaries: ['git'] }), ['curl'])).toThrow(/no binary in common/);
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
