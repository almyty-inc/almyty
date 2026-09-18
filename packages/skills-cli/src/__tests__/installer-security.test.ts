/**
 * Security regression: skill names come from the backend and are used to
 * build filesystem paths. A traversal name must not let the installer
 * write or delete files outside the target skills directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { installSkills } from '../installer';

let root: string;
let skillsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-install-test-'));
  skillsDir = join(root, 'skills');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const target = () => ({ name: 'test-agent', skillsDir }) as any;

describe('installSkills path-traversal protection', () => {
  it('installs a normal skill inside skillsDir', () => {
    const res = installSkills([{ name: 'weather', content: 'author: almyty\n' } as any], target());
    expect(res.installed).toBe(1);
    expect(existsSync(join(skillsDir, 'weather', 'SKILL.md'))).toBe(true);
  });

  it('skips a traversal name and writes nothing outside skillsDir', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A sentinel file a level above skillsDir that must not be touched.
    const sentinel = join(root, 'SENTINEL');
    writeFileSync(sentinel, 'keep', 'utf-8');

    installSkills(
      [{ name: '../../evil', content: 'pwned' } as any, { name: 'good', content: 'author: almyty\n' } as any],
      target(),
    );

    // The valid skill still installs; the malicious one is skipped.
    expect(existsSync(join(skillsDir, 'good', 'SKILL.md'))).toBe(true);
    // Nothing escaped: the only entries under skillsDir are safe names.
    expect(readdirSync(skillsDir).sort()).toEqual(['good']);
    // The sentinel above skillsDir is untouched and no evil dir appeared.
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(join(root, 'evil'))).toBe(false);
  });

  it('does not recursively delete an out-of-tree legacy dir via a crafted name', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outside = join(root, 'important');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'data.txt'), 'precious', 'utf-8');

    // A name engineered so the legacy-dir cleanup would target `../important`.
    installSkills([{ name: '../important', content: 'x' } as any], target());

    expect(existsSync(join(outside, 'data.txt'))).toBe(true);
  });

  it.each(['.', '..', 'a/b', 'a\\b', '../x', '/etc/passwd', ''])(
    'rejects unsafe name %j',
    (bad) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = installSkills([{ name: bad, content: 'x' } as any], target());
      // The counts report what reached disk, not what was offered:
      // counting the input said "installed 1" for zero files written.
      expect(res.installed).toBe(0);
      expect(res.skipped).toBe(1);
      expect(res.files).toEqual([]);
      expect(existsSync(join(skillsDir, bad, 'SKILL.md'))).toBe(false);
    },
  );

  it('reports how many files it replaced, and does not create the directory in a dry run', () => {
    // Installing writes into a directory an editor reads on every
    // session. --dry-run has to resolve the real paths and touch
    // nothing, and a real install has to say what it overwrote.
    const skill = { name: 'weather', content: 'author: almyty\n' } as any;

    const dry = installSkills([skill], target(), { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.installed).toBe(1);
    expect(dry.overwritten).toBe(0);
    expect(dry.files).toEqual([join(skillsDir, 'weather', 'SKILL.md')]);
    expect(existsSync(skillsDir)).toBe(false);

    const first = installSkills([skill], target());
    expect(first.overwritten).toBe(0);
    expect(existsSync(join(skillsDir, 'weather', 'SKILL.md'))).toBe(true);

    const second = installSkills([skill], target());
    expect(second.overwritten).toBe(1);

    const dryOverExisting = installSkills([skill], target(), { dryRun: true });
    expect(dryOverExisting.overwritten).toBe(1);
  });

  it('a dry run over an unsafe name still writes nothing and still refuses', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = installSkills([{ name: '../evil', content: 'x' } as any], target(), {
      dryRun: true,
    });
    expect(res.installed).toBe(0);
    expect(res.skipped).toBe(1);
    expect(existsSync(skillsDir)).toBe(false);
  });
});
