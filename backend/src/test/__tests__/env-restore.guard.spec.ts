import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import { restoreEnv, snapshotEnv } from '../env';

/**
 * A spec that changes an environment variable and puts it back with
 * `process.env.X = saved` writes the string "undefined" when X was unset,
 * and that string is what every later spec in the worker sees.
 */
const KEY = 'ALMYTY_ENV_RESTORE_GUARD_PROBE';
const SRC_ROOT = join(__dirname, '..', '..');
const EE_ROOT = join(SRC_ROOT, '..', 'ee');

function specs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : specs(path);
    // This file spells the pattern out on purpose.
    return path.endsWith('.spec.ts') && path !== __filename ? [path] : [];
  });
}

/**
 * Lines that assign a saved value back to process.env with no undefined
 * check in the lines just above: `const saved = process.env.X` ...
 * `process.env.X = saved;`.
 */
function rawEnvRestores(source: string): number[] {
  const lines = source.split('\n');
  const snapshots = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(/(\w+)\s*[:=]\s*process\.env(?:\.\w+|\[[^\]]+\])\s*[,;}]/g)) {
      snapshots.add(m[1]);
    }
  }
  const offenders: number[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/process\.env(?:\.\w+|\[[^\]]+\])\s*=\s*([\w.]+)\s*;/);
    if (!m) return;
    const ident = m[1].split('.').pop() as string;
    const restoresSnapshot =
      snapshots.has(ident) || /^(orig|prev|saved|old|before)/i.test(ident);
    if (!restoresSnapshot) return;
    const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
    if (/[!=]==\s*undefined|[!=]=\s*null/.test(context)) return;
    offenders.push(i + 1);
  });
  return offenders;
}

describe('restoring environment variables in specs', () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it('a plain assignment of undefined stores the string "undefined"', () => {
    const saved = process.env[KEY];
    process.env[KEY] = 'changed';
    (process.env as Record<string, unknown>)[KEY] = saved;
    expect(process.env[KEY]).toBe('undefined');
  });

  it('restoreEnv deletes a key that was unset and puts a set one back', () => {
    process.env[KEY] = 'changed';
    restoreEnv(KEY, undefined);
    expect(KEY in process.env).toBe(false);

    restoreEnv(KEY, 'original');
    expect(process.env[KEY]).toBe('original');
  });

  it('snapshotEnv puts every key back exactly', () => {
    process.env[KEY] = 'set-before';
    const other = `${KEY}_UNSET`;
    const restore = snapshotEnv(KEY, other);
    process.env[KEY] = 'changed';
    process.env[other] = 'changed';
    restore();
    expect(process.env[KEY]).toBe('set-before');
    expect(other in process.env).toBe(false);
  });

  it('the scanner catches the raw pattern and passes the guarded forms', () => {
    expect(rawEnvRestores(['const prev = process.env.A;', 'process.env.A = prev;'].join('\n'))).toEqual([2]);
    expect(
      rawEnvRestores(
        ['const prev = process.env.A;', 'if (prev === undefined) delete process.env.A;', 'else process.env.A = prev;'].join(
          '\n',
        ),
      ),
    ).toEqual([]);
    expect(rawEnvRestores("process.env.A = 'literal';")).toEqual([]);
  });

  it('no spec restores a saved value with a raw assignment', () => {
    const offenders = [...specs(SRC_ROOT), ...specs(EE_ROOT)].flatMap((file) =>
      rawEnvRestores(readFileSync(file, 'utf8')).map((line) => `${relative(SRC_ROOT, file)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
