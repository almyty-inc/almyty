import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `users.hasPassword`: whether the person chose a password. Accounts that
 * single sign-on or SCIM create get a random hash nobody knows, so they
 * start without one, and Settings says so.
 */
export class UserHasPassword1791000800000 implements MigrationInterface {
  name = 'UserHasPassword1791000800000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hasPassword" BOOLEAN NOT NULL DEFAULT true`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "hasPassword"`);
  }
}
