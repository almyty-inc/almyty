import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Why a provider connection is inactive.
 *
 * Check again turns a connection back on only when it went inactive
 * because a check failed, never when a person switched it off on purpose
 * or its endpoint stopped. Status alone cannot tell those apart, so the
 * reason is kept beside it: `check_failed`, `switched_off` or
 * `endpoint_stopped`, null while the connection is active.
 */
export class ProviderInactiveReason1750813765000 implements MigrationInterface {
  name = 'ProviderInactiveReason1750813765000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "inactiveReason" character varying(32)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "llm_providers" DROP COLUMN IF EXISTS "inactiveReason"`);
  }
}
