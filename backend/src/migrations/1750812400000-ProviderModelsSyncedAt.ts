import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When a sync last imported a provider's model list. A provider with no
 * value has never been synced, and the boot-time catalog sync (see
 * CatalogWarmupService) checks its key and lists its models once.
 */
export class ProviderModelsSyncedAt1750812400000 implements MigrationInterface {
  name = 'ProviderModelsSyncedAt1750812400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE llm_providers ADD COLUMN IF NOT EXISTS "modelsSyncedAt" TIMESTAMP WITH TIME ZONE NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE llm_providers DROP COLUMN IF EXISTS "modelsSyncedAt"`);
  }
}
