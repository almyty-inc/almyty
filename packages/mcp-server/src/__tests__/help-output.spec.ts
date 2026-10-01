/**
 * The --help text is the first thing a user reads, and it is long enough
 * that an edit can leave a stray line behind unnoticed. These run the real
 * entry point and read what it prints.
 */

import { execFileSync } from 'child_process';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const help = execFileSync(process.execPath, ['--import', 'tsx', join('src', 'index.ts'), '--help'], {
  cwd: join(import.meta.dirname, '..', '..'),
  encoding: 'utf-8',
});
const lines = help.split('\n');

describe('--help', () => {
  it('prints no prose line twice', () => {
    const prose = lines.map((l) => l.trim()).filter((l) => l.length > 0);
    const seen = new Set<string>();
    const repeated = prose.filter((l) => (seen.has(l) ? true : (seen.add(l), false)));
    expect(repeated).toEqual([]);
  });

  it('separates the usage list from the paragraph about stdio', () => {
    const at = lines.findIndex((l) => l.startsWith('The server speaks MCP over stdio'));
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe('');
    expect(lines[at - 2]).toContain('--version');
  });

  it('says once that the server is not run by hand', () => {
    expect(help.match(/run by hand\./g)).toHaveLength(1);
  });
});
