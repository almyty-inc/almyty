import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * An extension is database-wide, but its functions live in the one schema
 * it was created in. A DB-integration spec that says a bare
 * `CREATE EXTENSION` puts it in whatever schema is first on its
 * search_path -- its own, if it runs with `search_path=<schema>,public` --
 * and every other spec then fails with "function uuid_generate_v4() does
 * not exist". Specs create extensions only `WITH SCHEMA public`.
 *
 * This is the source half of the guard; the run half is the jest
 * globalTeardown (src/test/integration-global-teardown.ts), which fails a
 * run that left an extension outside public however it got there (a
 * spec's migrations included).
 */

// Creates a bare extension on purpose, in a throwaway database of its own,
// to prove provisionExtensionsInPublic moves it back.
const EXEMPT = new Set(['test-db-extensions.integration.spec.ts']);

function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line));
}

describe('integration specs create extensions only in public', () => {
  const dir = join(__dirname, '..', 'integration');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !EXEMPT.has(f));

  it('finds the integration specs', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('%s', (file) => {
    const bare = codeLines(readFileSync(join(dir, file), 'utf8'))
      .filter((line) => /CREATE EXTENSION/i.test(line))
      .filter((line) => !/WITH SCHEMA public\b/i.test(line));
    expect(bare).toEqual([]);
  });
});

/**
 * The run half of the guard reads database-wide state, so it runs once, in
 * the jest globalTeardown, after every worker has finished. As an afterAll
 * in the per-file setup it ran in parallel with other workers' migrations
 * and failed whichever spec was finishing when another's DDL had an
 * extension in flight (rbac-guard.integration.spec, which touches no
 * database, among them).
 */
describe('the extension check runs once, after the whole run', () => {
  const testDir = join(__dirname, '..');

  it('the per-file setup reads no database-wide extension state', () => {
    const setup = readFileSync(join(testDir, 'setup.ts'), 'utf8');
    expect(setup).not.toMatch(/assertExtensionsInPublic|extensionsOutsidePublic/);
  });

  it('the jest globalTeardown asserts it', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jestConfig = require(join(testDir, '..', '..', 'package.json')).jest;
    expect(jestConfig.globalTeardown).toBe('<rootDir>/test/integration-global-teardown.ts');
    const teardown = readFileSync(join(testDir, 'integration-global-teardown.ts'), 'utf8');
    expect(teardown).toMatch(/await assertExtensionsInPublic\(\)/);
  });
});
