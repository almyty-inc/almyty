import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeOperationIdNullable1730300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign key
    await queryRunner.query(`
      ALTER TABLE "tools"
      DROP CONSTRAINT IF EXISTS "FK_97637170f7ecdfaac6f718419fb"
    `);

    // Make nullable
    await queryRunner.query(`
      ALTER TABLE "tools"
      ALTER COLUMN "operationId" DROP NOT NULL
    `);

    // Re-add FK that allows NULL
    await queryRunner.query(`
      ALTER TABLE "tools"
      ADD CONSTRAINT "FK_97637170f7ecdfaac6f718419fb"
      FOREIGN KEY ("operationId") REFERENCES "operations"("id")
      ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tools"
      DROP CONSTRAINT IF EXISTS "FK_97637170f7ecdfaac6f718419fb"
    `);

    await queryRunner.query(`
      DELETE FROM "tools" WHERE "operationId" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "tools"
      ALTER COLUMN "operationId" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "tools"
      ADD CONSTRAINT "FK_97637170f7ecdfaac6f718419fb"
      FOREIGN KEY ("operationId") REFERENCES "operations"("id")
      ON DELETE CASCADE
    `);
  }
}
