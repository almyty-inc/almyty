import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChangeCostColumnsToFloat1741800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Change cost column from integer to float in llm_messages
    await queryRunner.query(`
      ALTER TABLE "llm_messages"
      ALTER COLUMN "cost" TYPE double precision USING "cost"::double precision
    `);

    // Change totalCost column from integer to float in llm_sessions
    await queryRunner.query(`
      ALTER TABLE "llm_sessions"
      ALTER COLUMN "totalCost" TYPE double precision USING "totalCost"::double precision
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_messages"
      ALTER COLUMN "cost" TYPE integer USING ROUND("cost")::integer
    `);

    await queryRunner.query(`
      ALTER TABLE "llm_sessions"
      ALTER COLUMN "totalCost" TYPE integer USING ROUND("totalCost")::integer
    `);
  }
}
