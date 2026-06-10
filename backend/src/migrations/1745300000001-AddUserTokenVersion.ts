import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add users.tokenVersion for session/token invalidation.
 *
 * Issued JWTs carry the tokenVersion they were minted with. The JWT
 * strategy and the refresh path reject any token whose `tv` claim no
 * longer matches the user's current tokenVersion, so bumping the column
 * (on password change / reset) revokes every outstanding access and
 * refresh token for that user.
 *
 * Defaults to 0 and is NOT NULL; tokens minted before this column
 * existed carry no `tv` claim and are treated as 0, so they remain valid
 * until the first bump. IF NOT EXISTS keeps the migration idempotent
 * against fresh installs that synced via TypeORM in dev.
 */
export class AddUserTokenVersion1745300000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "tokenVersion" integer NOT NULL DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "tokenVersion";
    `);
  }
}
