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
 * This is the source half of the guard; the run half is the afterAll in
 * src/test/setup.ts, which fails an integration spec file that left an
 * extension outside public however it got there (its migrations included).
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
