import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Funnel analytics on the user row (modules/product-analytics):
 *
 * - `signupAttribution`: the whitelisted utm_* / cta keys of the link the
 *   person signed up from.
 * - `signupEventAt` / `firstRunEventAt`: when `signup_completed` and
 *   `first_run_succeeded` were claimed. Each is set by a conditional UPDATE
 *   that only matches while it is NULL, which is what makes each event
 *   once-only across restarts and replicas.
 */
export class UserFunnelAnalytics1791001900000 implements MigrationInterface {
  name = 'UserFunnelAnalytics1791001900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signupAttribution" jsonb`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signupEventAt" timestamptz`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "firstRunEventAt" timestamptz`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "firstRunEventAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "signupEventAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "signupAttribution"`);
  }
}
