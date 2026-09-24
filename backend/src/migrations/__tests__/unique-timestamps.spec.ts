import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..');

/**
 * One timestamp per migration. See ../README.md.
 *
 * TypeORM orders migrations by the 13-digit timestamp at the end of the
 * class name and records each by name. Two migrations sharing a timestamp
 * both run, but their relative order is no longer something the numbers
 * say, so a later migration that depends on one of them can run before
 * it on a fresh database while having run after it everywhere else.
 */

/**
 * Pairs that shipped before this guard existed. Both have already run on
 * staging and production, and renaming either would change its recorded
 * name, so TypeORM would run it again. They touch unrelated tables
 * (agent collaboration vs. resource visibility), so their order does not
 * matter. Never add to this list: pick the next free timestamp instead.
 */
const HISTORICAL_COLLISIONS: Record<string, string[]> = {
  '1750808000000': ['CollaborationParticipants1750808000000', 'PrivateVisibility1750808000000'],
};

const files = readdirSync(MIGRATIONS).filter((f) => /^\d{13}-.*\.ts$/.test(f));

function className(file: string): string {
  const match = readFileSync(join(MIGRATIONS, file), 'utf8').match(/export class (\w+)/);
  if (!match) throw new Error(`${file} exports no migration class`);
  return match[1];
}

const migrations = files.map((file) => ({ file, cls: className(file), ts: file.slice(0, 13) }));

describe('migration timestamps', () => {
  it('finds the migrations (a guard reading an empty directory proves nothing)', () => {
    expect(migrations.length).toBeGreaterThan(50);
  });

  it('names each class with the timestamp its file carries, which is the one TypeORM orders by', () => {
    const mismatched = migrations.filter(({ cls, ts }) => !cls.endsWith(ts)).map(({ file, cls }) => `${file}: ${cls}`);
    expect(mismatched).toEqual([]);
  });

  it('gives every migration a timestamp of its own', () => {
    const byTs = new Map<string, string[]>();
    for (const { ts, cls } of migrations) byTs.set(ts, [...(byTs.get(ts) ?? []), cls]);

    const collisions = [...byTs.entries()]
      .filter(([, classes]) => classes.length > 1)
      .filter(([ts, classes]) => {
        const allowed = HISTORICAL_COLLISIONS[ts];
        return !allowed || [...classes].sort().join() !== [...allowed].sort().join();
      })
      .map(([ts, classes]) => `${ts}: ${classes.join(', ')}`);

    expect(collisions).toEqual([]);
  });

  it('keeps the historical list honest', () => {
    for (const [ts, classes] of Object.entries(HISTORICAL_COLLISIONS)) {
      const present = migrations.filter((m) => m.ts === ts).map((m) => m.cls).sort();
      expect(present).toEqual([...classes].sort());
    }
  });
});