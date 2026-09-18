import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The durable reason a schema import failed.
 *
 * It lived only in the BullMQ job, read back as `job.failedReason`.
 * Imports are enqueued with `removeOnFail: 50`, so the reason is evicted
 * by the next fifty failures or by a Redis restart — and a schema import
 * is a minutes-long operation with a dozen legible failure modes, which
 * is exactly the kind of answer that has to survive.
 */
export class ApiLastImportError1750805000000 implements MigrationInterface {
  name = 'ApiLastImportError1750805000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "apis"
        ADD COLUMN IF NOT EXISTS "lastImportError" text
    `);
    await queryRunner.query(`
      ALTER TABLE "apis"
        ADD COLUMN IF NOT EXISTS "lastImportFailedAt" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "apis" DROP COLUMN IF EXISTS "lastImportFailedAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "apis" DROP COLUMN IF EXISTS "lastImportError"
    `);
  }
}
