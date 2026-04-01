import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentCapabilities1743600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS "agentConfig" JSON NULL
    `);
    await queryRunner.query(`
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS "isTemporary" BOOLEAN DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS "parentRunId" VARCHAR NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE agents DROP COLUMN IF EXISTS "parentRunId"
    `);
    await queryRunner.query(`
      ALTER TABLE agents DROP COLUMN IF EXISTS "isTemporary"
    `);
    await queryRunner.query(`
      ALTER TABLE agents DROP COLUMN IF EXISTS "agentConfig"
    `);
  }
}
