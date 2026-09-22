import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Whether a strategy is offered without a claim that it pays off.
 *
 * Its own column rather than a convention over the description, because
 * the picker has to badge it and the seeder has to set it, and a flag
 * that only exists in prose is one that eventually disagrees with itself.
 *
 * Defaults false: a shape is ordinary unless someone says otherwise.
 */
export class StrategyExperimental1750768500000 implements MigrationInterface {
  name = 'StrategyExperimental1750768500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "experimental" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`UPDATE "strategies" SET "experimental" = true WHERE "key" = 'explore_extract_patch' AND "organizationId" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "strategies" DROP COLUMN IF EXISTS "experimental"`);
  }
}
