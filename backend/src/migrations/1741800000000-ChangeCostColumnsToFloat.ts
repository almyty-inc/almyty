import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChangeCostColumnsToFloat1741800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Change cost column from integer to float in llm_messages
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='llm_messages' AND column_name='cost' AND data_type != 'double precision') THEN
          ALTER TABLE "llm_messages" ALTER COLUMN "cost" TYPE double precision USING "cost"::double precision;
        END IF;
      END $$;
    `);

    // Change totalCost column from integer to float in llm_sessions
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='llm_sessions' AND column_name='totalCost' AND data_type != 'double precision') THEN
          ALTER TABLE "llm_sessions" ALTER COLUMN "totalCost" TYPE double precision USING "totalCost"::double precision;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='llm_messages' AND column_name='cost' AND data_type = 'double precision') THEN
          ALTER TABLE "llm_messages" ALTER COLUMN "cost" TYPE integer USING ROUND("cost")::integer;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='llm_sessions' AND column_name='totalCost' AND data_type = 'double precision') THEN
          ALTER TABLE "llm_sessions" ALTER COLUMN "totalCost" TYPE integer USING ROUND("totalCost")::integer;
        END IF;
      END $$;
    `);
  }
}
