import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a visitor's erasure and an owner's data request look memories up by.
 *
 * `memory_expiries.run_id`: the run that saved a memory in an outside
 * memory service, so erasing the visitor whose run it was reaches it
 * there too.
 * there too. `channel_events.senderId`: who sent an inbound message, so
 * the messages of theirs that never became a run are found too.
 *
 * Lookups that would otherwise scan: memories by the run that wrote
 * them (`provenance->>'session_id'`), outside memories by scope, and
 * inbound deliveries by sender.
 */
export class VisitorDataRequests1750813795000 implements MigrationInterface {
  name = 'VisitorDataRequests1750813795000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE memory_expiries ADD COLUMN IF NOT EXISTS run_id TEXT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS memory_expiries_run ON memory_expiries (run_id) WHERE run_id IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS memory_expiries_scope ON memory_expiries (organization_id, scope_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS memories_session ON memories ((provenance->>'session_id'))`);
    await queryRunner.query(`ALTER TABLE channel_events ADD COLUMN IF NOT EXISTS "senderId" varchar(255) NULL`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_channel_events_gateway_sender" ON channel_events ("gatewayId", "senderId") WHERE "senderId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS memories_session`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_events_gateway_sender"`);
    await queryRunner.query(`ALTER TABLE channel_events DROP COLUMN IF EXISTS "senderId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS memory_expiries_scope`);
    await queryRunner.query(`DROP INDEX IF EXISTS memory_expiries_run`);
    await queryRunner.query(`ALTER TABLE memory_expiries DROP COLUMN IF EXISTS run_id`);
  }
}
