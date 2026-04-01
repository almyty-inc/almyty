import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrgAgentDefaults1743500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "agentDefaults" JSON NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE organizations DROP COLUMN IF EXISTS "agentDefaults"
    `);
  }
}
