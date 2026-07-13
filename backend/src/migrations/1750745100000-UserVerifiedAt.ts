import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Email verification timestamp for the new (non-blocking) verify-email
 * flow. NULL = unverified. Kept alongside the legacy `isVerified`
 * boolean, which stays for backwards compatibility and is set together
 * with verifiedAt.
 */
export class UserVerifiedAt1750745100000 implements MigrationInterface {
  name = 'UserVerifiedAt1750745100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMPTZ`,
    );
    // Users already marked verified through the legacy boolean keep
    // their verified status under the new column.
    await queryRunner.query(
      `UPDATE users SET "verifiedAt" = now() WHERE "isVerified" = true AND "verifiedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS "verifiedAt"`,
    );
  }
}
