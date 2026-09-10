import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Every column the Strategy entity declares must exist in a migration.
 *
 * `synchronize` is off, so a column that lives only in the entity is a
 * column that does not exist in any database that was not built by this
 * repo's own test bootstrap. The `experimental` flag shipped exactly that
 * way for one commit: entity, seed, controller and picker all correct,
 * and the column absent everywhere it mattered.
 */
describe('the strategies table matches the Strategy entity', () => {
  const root = join(__dirname, '../../../../');
  const entity = readFileSync(join(root, 'entities/strategy.entity.ts'), 'utf8');

  const migrationSql = readdirSync(join(root, 'migrations'))
    .filter((f) => /Strateg/i.test(f))
    .map((f) => readFileSync(join(root, 'migrations', f), 'utf8'))
    .join('\n');

  // `@Column({...}) name: type` and `@Column() name: type`, which is how
  // every column on this entity is written.
  const declared = [...entity.matchAll(/@Column\([^)]*\)\s*\n\s*(\w+)[?!]?:/g)].map((m) => m[1]);

  it('declares columns at all, so an empty match cannot pass silently', () => {
    expect(declared).toEqual(expect.arrayContaining(['key', 'displayName', 'shape', 'experimental']));
  });

  it('has a migration for every one of them', () => {
    const orphans = declared.filter((column) => !migrationSql.includes(`"${column}"`));
    expect(orphans).toEqual([]);
  });
});
