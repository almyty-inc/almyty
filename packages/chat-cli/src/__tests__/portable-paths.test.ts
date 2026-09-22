/**
 * Guard for the defect in #657.
 *
 * `input.test.ts` asserted that appendHistory survives an unwritable path by
 * pointing it at `/proc/definitely/not/writable/history`. On macOS that is
 * ENOENT, instantly. On Linux `/proc` is a live virtual filesystem and
 * `mkdirSync(..., { recursive: true })` under it does not fail -- it blocks,
 * indefinitely. The suite therefore passed on every developer machine and
 * hung the Linux CI leg until the job timeout killed it.
 *
 * The lesson generalises past that one line: a test must not reach into a
 * kernel-owned path to find something unwritable. Use a path *through* a
 * regular file, which answers ENOTDIR everywhere and at once.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = import.meta.dirname;

// Kernel-owned trees whose behaviour differs by platform. /dev is included
// because /dev/full, /dev/null and friends are equally tempting and equally
// platform-dependent as a stand-in for "a path that cannot be written".
const FORBIDDEN = [/['"`]\/proc\//, /['"`]\/sys\//, /['"`]\/dev\//];

describe('tests do not reach into kernel-owned paths', () => {
  const files = readdirSync(TEST_DIR).filter((f) => /\.tsx?$/.test(f) && f !== 'portable-paths.test.ts');

  it('finds the suite files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no test hard-codes a /proc, /sys or /dev path', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(join(TEST_DIR, file), 'utf-8');
      source.split('\n').forEach((line, i) => {
        // Skip comments -- this file's own explanation, and the warning left
        // at the original call site, both name /proc on purpose.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (FORBIDDEN.some((re) => re.test(code))) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      'these paths behave differently per platform and can block rather than fail -- ' +
        'use a path through a regular file for ENOTDIR instead:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
