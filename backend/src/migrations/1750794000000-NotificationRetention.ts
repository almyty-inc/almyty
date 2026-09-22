import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A retention window for notifications.
 *
 * The other per-event table with no sweep. Rows are written per failed
 * scheduled or webhook run and per approval request and decision, so a
 * permanently broken 5-minute schedule writes 288 a day forever -- and
 * schedules do break, which is why there is now a RESTORE_FAILED pause
 * for the ones a restart could not bring back.
 *
 * Null means keep forever, matching every sibling column, so nothing
 * changes for an install until somebody sets a window.
 */
export class NotificationRetention1750794000000 implements MigrationInterface {
  name = 'NotificationRetention1750794000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE retention_policies
      ADD COLUMN IF NOT EXISTS "notificationsDays" integer
    `);

    // The sweep deletes by (organizationId, createdAt).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS notifications_org_created_idx
      ON notifications ("organizationId", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS notifications_org_created_idx`);
    await queryRunner.query(`ALTER TABLE retention_policies DROP COLUMN IF EXISTS "notificationsDays"`);
  }
}
