import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a visitor's erasure and an owner's data request look memories up by.
 *
 * `memory_expiries.run_id`: the run that saved a memory in an outside
 * memory service, so erasing the visitor whose run it was reaches it
 * there too.
 *
 * Two lookups that would otherwise scan: memories by the run that wrote
 * them (`provenance->>'session_id'`), and outside memories by scope.
 */
export class VisitorDataRequests1750813795000 implements MigrationInterface {
  name = 'VisitorDataRequests1750813795000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE memory_expiries ADD COLUMN IF NOT EXISTS run_id TEXT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS memory_expiries_run ON memory_expiries (run_id) WHERE run_id IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS memory_expiries_scope ON memory_expiries (organization_id, scope_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS memories_session ON memories ((provenance->>'session_id'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS memories_session`);
    await queryRunner.query(`DROP INDEX IF EXISTS memory_expiries_scope`);
    await queryRunner.query(`DROP INDEX IF EXISTS memory_expiries_run`);
    await queryRunner.query(`ALTER TABLE memory_expiries DROP COLUMN IF EXISTS run_id`);
  }
}
