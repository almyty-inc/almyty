import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification system foundation: persistent in-app notifications
 * (one row per recipient per event) and per-user per-event-type
 * channel preferences (rows exist only for explicit overrides; the
 * defaults matrix lives in code).
 */
export class Notifications1750745000000 implements MigrationInterface {
  name = 'Notifications1750745000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL,
        "organizationId" UUID NOT NULL,
        "type" VARCHAR(64) NOT NULL,
        "title" VARCHAR(255) NOT NULL,
        "body" TEXT NOT NULL,
        "link" TEXT,
        "readAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS notifications_user_read_idx
       ON notifications ("userId", "readAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS notifications_user_created_idx
       ON notifications ("userId", "createdAt")`,
    );
    // Org-scoped dedupe lookups (retention sweep daily cap).
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS notifications_org_type_created_idx
       ON notifications ("organizationId", "type", "createdAt")`,
    );
    await queryRunner.query(`
      ALTER TABLE notifications
      ADD CONSTRAINT notifications_user_fk
      FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE notifications
      ADD CONSTRAINT notifications_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL,
        "type" VARCHAR(64) NOT NULL,
        "inApp" BOOLEAN NOT NULL DEFAULT true,
        "email" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_user_type_uq
       ON notification_preferences ("userId", "type")`,
    );
    await queryRunner.query(`
      ALTER TABLE notification_preferences
      ADD CONSTRAINT notification_preferences_user_fk
      FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS notification_preferences CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS notifications CASCADE`);
  }
}
