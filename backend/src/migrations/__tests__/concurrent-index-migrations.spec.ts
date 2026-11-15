import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * A migration that builds or drops an index CONCURRENTLY cannot run in a
 * transaction, so it sets `transaction = false`; TypeORM refuses that
 * override unless migrations run in 'each' mode. Both the migration Job's
 * data source (database.config.ts) and the app's (app-typeorm.options.ts)
 * have to say so, or the deploy fails at the migration step.
 */
const MIGRATIONS = join(__dirname, '..');
const CONFIG = join(__dirname, '..', '..', 'config');

describe('CONCURRENTLY index migrations', () => {
  const concurrent = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{13}-.*\.ts$/.test(f))
    .filter((f) => /\bCONCURRENTLY\b/.test(readFileSync(join(MIGRATIONS, f), 'utf8')));

  it('there is at least one (the guard is not vacuous)', () => {
    expect(concurrent).toContain('1791001600000-IndexApiDeleteCascadeForeignKeys.ts');
  });

  it.each(concurrent)('%s runs outside a transaction', (file) => {
    expect(readFileSync(join(MIGRATIONS, file), 'utf8')).toMatch(/^\s*transaction = false\b/m);
  });

  it.each(['database.config.ts', 'app-typeorm.options.ts'])('%s runs migrations one transaction each', (file) => {
    expect(readFileSync(join(CONFIG, file), 'utf8')).toMatch(/migrationsTransactionMode: 'each'/);
  });
});
