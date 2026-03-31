import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCollaborationAndSleeping1743200000000 implements MigrationInterface {
  name = 'AddCollaborationAndSleeping1743200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS collaboration JSON NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE agents DROP COLUMN IF EXISTS collaboration
    `);
  }
}
