import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExecutionMethodToTools1730200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tools"
      ADD COLUMN IF NOT EXISTS "executionMethod" VARCHAR NULL,
      ADD COLUMN IF NOT EXISTS "authConfig" JSONB NULL
    `);

    // Update existing tools with operationId to use HTTP method
    await queryRunner.query(`
      UPDATE "tools"
      SET "executionMethod" = 'http'
      WHERE "operationId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tools"
      DROP COLUMN IF EXISTS "executionMethod",
      DROP COLUMN IF EXISTS "authConfig"
    `);
  }
}
