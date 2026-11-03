import { getMetadataArgsStorage } from 'typeorm';

import { CENTS, SpendAlert } from '../../../entities/spend-alert.entity';
import { SpendAlertFractionalCents1791000700000 } from '../../../migrations/1791000700000-SpendAlertFractionalCents';

/**
 * The alert history keeps the fraction the alert's text shows: a one-cent
 * budget's warning at 0.82 cents is stored as 0.82, not a rounded 1.
 */
describe('spend_alerts.spentCents keeps fractions of a cent', () => {
  const column = getMetadataArgsStorage().columns.find((c) => c.target === SpendAlert && c.propertyName === 'spentCents')!;

  it('is a numeric column read back as a number', () => {
    expect(column.options).toMatchObject({ type: 'numeric', scale: 4 });
    expect(CENTS.from('0.8200')).toBe(0.82);
    expect(CENTS.from(null)).toBeNull();
  });

  it('has a migration that changes the column, and back', async () => {
    const queries: string[] = [];
    const q = { query: async (sql: string) => void queries.push(sql) } as any;
    const migration = new SpendAlertFractionalCents1791000700000();
    await migration.up(q);
    await migration.down(q);
    expect(queries[0]).toMatch(/ALTER TABLE "spend_alerts" ALTER COLUMN "spentCents" TYPE NUMERIC\(14,4\)/);
    expect(queries[1]).toMatch(/TYPE INTEGER USING round\("spentCents"\)/);
  });
});
