import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCollaborationColumn1743300000000 implements MigrationInterface {
  name = 'AddCollaborationColumn1743300000000';

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
