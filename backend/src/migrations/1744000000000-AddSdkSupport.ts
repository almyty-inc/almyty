import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSdkSupport1744000000000 implements MigrationInterface {
  name = 'AddSdkSupport1744000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add SDK fields to apis table
    await queryRunner.query(`ALTER TABLE apis ADD COLUMN IF NOT EXISTS dependencies JSONB NULL`);
    await queryRunner.query(`ALTER TABLE apis ADD COLUMN IF NOT EXISTS "npmRegistry" JSONB NULL`);
    await queryRunner.query(`ALTER TABLE apis ADD COLUMN IF NOT EXISTS "sdkMaps" JSONB NULL`);

    // Add SDK fields to tools table
    await queryRunner.query(`ALTER TABLE tools ADD COLUMN IF NOT EXISTS dependencies JSONB NULL`);
    await queryRunner.query(`ALTER TABLE tools ADD COLUMN IF NOT EXISTS "npmRegistry" JSONB NULL`);
    await queryRunner.query(`ALTER TABLE tools ADD COLUMN IF NOT EXISTS "sdkConfig" JSONB NULL`);

    // Add SDK fields to tool_templates table
    await queryRunner.query(`ALTER TABLE tool_templates ADD COLUMN IF NOT EXISTS "sdkConfig" JSONB NULL`);
    await queryRunner.query(`ALTER TABLE tool_templates ADD COLUMN IF NOT EXISTS "sdkMap" JSONB NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop SDK fields from tool_templates table
    await queryRunner.query(`ALTER TABLE tool_templates DROP COLUMN IF EXISTS "sdkMap"`);
    await queryRunner.query(`ALTER TABLE tool_templates DROP COLUMN IF EXISTS "sdkConfig"`);

    // Drop SDK fields from tools table
    await queryRunner.query(`ALTER TABLE tools DROP COLUMN IF EXISTS "sdkConfig"`);
    await queryRunner.query(`ALTER TABLE tools DROP COLUMN IF EXISTS "npmRegistry"`);
    await queryRunner.query(`ALTER TABLE tools DROP COLUMN IF EXISTS dependencies`);

    // Drop SDK fields from apis table
    await queryRunner.query(`ALTER TABLE apis DROP COLUMN IF EXISTS "sdkMaps"`);
    await queryRunner.query(`ALTER TABLE apis DROP COLUMN IF EXISTS "npmRegistry"`);
    await queryRunner.query(`ALTER TABLE apis DROP COLUMN IF EXISTS dependencies`);
  }
}
