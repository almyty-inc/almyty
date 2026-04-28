/**
 * Tests for target-selector.ts — the auto path of selectInstallTargets.
 * The interactive @clack picker isn't covered (would require stdin
 * fakes); the auto path covers --all / --agent / --path / --yes /
 * .almytyrc precedence and is what runs in CI / scripted use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { selectInstallTargetsAuto } from '../target-selector';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skills-selector-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('selectInstallTargetsAuto', () => {
  it('--path overrides every other source', () => {
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: { skillsDir: '/some/.almytyrc/path' },
      pathFlag: ['./custom-a', './custom-b'],
    });
    expect(targets).not.toBeNull();
    expect(targets!.map((t) => t.skillsDir)).toEqual([
      join(tmpDir, 'custom-a'),
      join(tmpDir, 'custom-b'),
    ]);
    // Detected codex must NOT also be added when --path is explicit.
    expect(targets!.some((t) => t.name === 'Codex')).toBe(false);
  });

  it('--path accepts comma-separated values in one flag', () => {
    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: {},
      pathFlag: './a,./b ./c',
    });
    expect(targets!.map((t) => t.skillsDir)).toEqual([
      join(tmpDir, 'a'),
      join(tmpDir, 'b'),
      join(tmpDir, 'c'),
    ]);
  });

  it('--all installs to every DETECTED agent + universal (not all known)', () => {
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });

    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: {},
      all: true,
    });
    const names = targets!.map((t) => t.name).sort();
    expect(names).toContain('Codex');
    expect(names).toContain('Claude Code');
    expect(names).toContain('Universal (.agents/skills)');
    // Critically: agents that are NOT detected must not be in the
    // result. `--all` installs everywhere you actually use, not
    // to every dir we know about.
    expect(names).not.toContain('Windsurf');
    expect(names).not.toContain('Goose');
  });

  it("--agent '*' installs to every known agent regardless of detection", () => {
    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: {},
      agentFlag: '*',
    });
    const names = targets!.map((t) => t.name);
    expect(names).toContain('Codex');
    expect(names).toContain('Windsurf');
    expect(names).toContain('Goose');
    expect(targets!.length).toBeGreaterThan(10);
  });

  it('--agent codex resolves Codex to .codex/skills (regression)', () => {
    // Pin a clean home so the real `~/.codex/` on the test runner
    // doesn't shift the resolution to home scope.
    const fakeHome = mkdtempSync(join(tmpdir(), 'skills-fake-home-'));
    try {
      const targets = selectInstallTargetsAuto({
        projectDir: tmpDir,
        config: {},
        agentFlag: 'codex',
        home: fakeHome,
      });
      const codex = targets!.find((t) => t.name === 'Codex');
      expect(codex).toBeDefined();
      expect(codex!.skillsDir).toBe(join(tmpDir, '.codex/skills'));
      expect(codex!.scope).toBe('project');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('--agent codex with home-detected and no project picks home scope', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'skills-fake-home-'));
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    try {
      const targets = selectInstallTargetsAuto({
        projectDir: tmpDir,
        config: {},
        agentFlag: 'codex',
        home: fakeHome,
      });
      const codex = targets!.find((t) => t.name === 'Codex');
      expect(codex).toBeDefined();
      expect(codex!.skillsDir).toBe(join(fakeHome, '.codex/skills'));
      expect(codex!.scope).toBe('home');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('--global picks home-scope even when project scope is detected', () => {
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    const fakeHome = mkdtempSync(join(tmpdir(), 'skills-fake-home-'));
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    try {
      const targets = selectInstallTargetsAuto({
        projectDir: tmpDir,
        config: {},
        agentFlag: 'codex',
        global: true,
        home: fakeHome,
      });
      const codex = targets!.find((t) => t.name === 'Codex');
      expect(codex!.skillsDir).toBe(join(fakeHome, '.codex/skills'));
      expect(codex!.scope).toBe('home');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('--all --global combines project- and home-detected', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    const fakeHome = mkdtempSync(join(tmpdir(), 'skills-fake-home-'));
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    try {
      const targets = selectInstallTargetsAuto({
        projectDir: tmpDir,
        config: {},
        all: true,
        global: true,
        home: fakeHome,
      });
      const claude = targets!.find((t) => t.name === 'Claude Code');
      const codex = targets!.find((t) => t.name === 'Codex');
      expect(claude!.scope).toBe('project');
      expect(claude!.skillsDir).toBe(join(tmpDir, '.claude/skills'));
      expect(codex!.scope).toBe('home');
      expect(codex!.skillsDir).toBe(join(fakeHome, '.codex/skills'));
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('--agent supports multiple values + universal cross-client target', () => {
    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: {},
      agentFlag: ['codex', 'claude'],
    });
    const names = targets!.map((t) => t.name).sort();
    expect(names).toContain('Codex');
    expect(names).toContain('Claude Code');
    // Universal is always added alongside specific agents so generic
    // .agents/skills/ scanners still see the install.
    expect(names).toContain('Universal (.agents/skills)');
  });

  it('--agent with no match throws', () => {
    expect(() =>
      selectInstallTargetsAuto({
        projectDir: tmpDir,
        config: {},
        agentFlag: 'this-does-not-exist',
      }),
    ).toThrow(/No known agents matched/);
  });

  it('.almytyrc skillsDir overrides detection', () => {
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: { skillsDir: './rc-path' },
    });
    expect(targets).toHaveLength(1);
    expect(targets![0].name).toBe('custom (.almytyrc)');
    expect(targets![0].skillsDir).toBe(join(tmpDir, 'rc-path'));
    expect(targets![0].scope).toBe('custom');
  });

  it('--yes uses detected agents + universal when in TTY', () => {
    mkdirSync(join(tmpDir, '.codex'), { recursive: true });
    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: {},
      yes: true,
    });
    const names = targets!.map((t) => t.name);
    expect(names).toContain('Codex');
    expect(names).toContain('Universal (.agents/skills)');
  });

  it('--yes with no detection falls back to defaults + universal', () => {
    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: {},
      yes: true,
    });
    const names = targets!.map((t) => t.name);
    // getDefaultTargets() returns Claude Code + Universal already.
    expect(names).toContain('Claude Code');
    expect(names).toContain('Universal (.agents/skills)');
  });

  it('returns null (interactive picker required) when TTY + no flags', () => {
    // Skipped if not running under a TTY (CI or piped stdin) — in
    // that case the function returns the auto fallback list, which
    // is also the right behavior.
    if (!process.stdin.isTTY) {
      const targets = selectInstallTargetsAuto({
        projectDir: tmpDir,
        config: {},
      });
      expect(targets).not.toBeNull();
      return;
    }
    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: {},
    });
    expect(targets).toBeNull();
  });

  it('dedupes targets that map to the same skillsDir', () => {
    // Cursor + Cline both map to .agents/skills/. With `--agent '*'`
    // the result still has each name listed once but the skillsDir
    // values are unique.
    const targets = selectInstallTargetsAuto({
      projectDir: tmpDir,
      config: {},
      agentFlag: '*',
    });
    const dirs = targets!.map((t) => t.skillsDir);
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});
