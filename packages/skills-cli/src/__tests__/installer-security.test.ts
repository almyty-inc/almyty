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
      expect(res.installed).toBe(1); // result counts the input, but nothing unsafe was written
      expect(existsSync(join(skillsDir, bad, 'SKILL.md'))).toBe(false);
    },
  );
});
