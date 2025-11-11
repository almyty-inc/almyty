import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeToolExecutionUserIdNullable1730000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the foreign key constraint
    await queryRunner.query(`
      ALTER TABLE "tool_executions"
      DROP CONSTRAINT IF EXISTS "FK_3e32da00bbffaf0b929f253b3e8"
    `);

    // Make userId nullable
    await queryRunner.query(`
      ALTER TABLE "tool_executions"
      ALTER COLUMN "userId" DROP NOT NULL
    `);

    // Re-add foreign key constraint that allows NULL
    await queryRunner.query(`
      ALTER TABLE "tool_executions"
      ADD CONSTRAINT "FK_3e32da00bbffaf0b929f253b3e8"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the nullable foreign key
    await queryRunner.query(`
      ALTER TABLE "tool_executions"
      DROP CONSTRAINT IF EXISTS "FK_3e32da00bbffaf0b929f253b3e8"
    `);

    // Delete any records with NULL userId
    await queryRunner.query(`
      DELETE FROM "tool_executions" WHERE "userId" IS NULL
    `);

    // Make userId NOT NULL again
    await queryRunner.query(`
      ALTER TABLE "tool_executions"
      ALTER COLUMN "userId" SET NOT NULL
    `);

    // Re-add original foreign key constraint
    await queryRunner.query(`
      ALTER TABLE "tool_executions"
      ADD CONSTRAINT "FK_3e32da00bbffaf0b929f253b3e8"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE
    `);
  }
}
