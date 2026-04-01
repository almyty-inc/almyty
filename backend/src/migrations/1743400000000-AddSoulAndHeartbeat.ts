import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSoulAndHeartbeat1743400000000 implements MigrationInterface {
  name = 'AddSoulAndHeartbeat1743400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS soul TEXT NULL`);
    await queryRunner.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS heartbeat JSON NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE agents DROP COLUMN IF EXISTS heartbeat`);
    await queryRunner.query(`ALTER TABLE agents DROP COLUMN IF EXISTS soul`);
  }
}
