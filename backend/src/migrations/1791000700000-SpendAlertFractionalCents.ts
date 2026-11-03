import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `spend_alerts.spentCents` keeps fractions of a cent. Spend is measured
 * in fractions (a model call costs a fraction of a cent), and a one-cent
 * budget warns at 0.82 cents; the history row now says 0.82, as the
 * alert's own text does, rather than a rounded 1.
 */
export class SpendAlertFractionalCents1791000700000 implements MigrationInterface {
  name = 'SpendAlertFractionalCents1791000700000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "spend_alerts" ALTER COLUMN "spentCents" TYPE NUMERIC(14,4) USING "spentCents"::numeric`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "spend_alerts" ALTER COLUMN "spentCents" TYPE INTEGER USING round("spentCents")::integer`);
  }
}
