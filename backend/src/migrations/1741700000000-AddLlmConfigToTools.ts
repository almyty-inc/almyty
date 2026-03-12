import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLlmConfigToTools1741700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add llmConfig column for LLM execution method tools
    await queryRunner.query(`
      ALTER TABLE "tools"
      ADD COLUMN IF NOT EXISTS "llmConfig" JSONB NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tools"
      DROP COLUMN IF EXISTS "llmConfig"
    `);
  }
}
