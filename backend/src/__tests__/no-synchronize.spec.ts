import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Nothing in shipped code sets `synchronize: true`.
 *
 * `run-migrations.ts` did, was compiled into the production image, and
 * its own header told operators to run it against their database. Nothing
 * invoked it -- the k8s job runs the TypeORM CLI -- so it sat there as a
 * loaded gun: running it would have let TypeORM diff entities against the
 * live schema and ALTER or DROP to match, including dropping every
 * migration-only column, and its entity glob did not even cover the
 * memory tables. That file is gone; this keeps the setting from coming
 * back.
 *
 * Tests may synchronize as much as they like against a throwaway
 * database, so __tests__ is exempt.
 */
const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'test') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

describe('schema is only ever changed by a migration', () => {
  const files = walk(SRC);

  it('finds source to check, so an empty sweep cannot pass', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('never enables synchronize outside tests', () => {
    const offenders = files.filter((file) => /synchronize:\s*true/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
