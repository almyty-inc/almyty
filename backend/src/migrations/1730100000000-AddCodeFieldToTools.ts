import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCodeFieldToTools1730100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tools"
      ADD COLUMN IF NOT EXISTS "code" TEXT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tools"
      DROP COLUMN IF EXISTS "code"
    `);
  }
}
