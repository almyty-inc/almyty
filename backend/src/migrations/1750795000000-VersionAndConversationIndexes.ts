import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the two tables whose only access paths were sequential
 * scans.
 *
 * `version` (typeorm-versions) was created with nothing but its primary
 * key, and the library's own entity declares no index either. Two
 * readers scan it: the Change History panel reads
 * (itemType, itemId) ordered by timestamp DESC, and the retention sweep
 * pages through `timestamp < cutoff`. The version subscriber writes a
 * full serialized entity on every save of a @VersionedEntity, and the
 * model reconcile loop saves several every couple of minutes per
 * deployment, so the table is one of the fastest-growing in the schema.
 * The hourly sweep is worst once the backlog has cleared: it scans the
 * whole table to return zero rows.
 *
 * The two ON DELETE SET NULL referrers of `conversations` had no index
 * on their referencing column -- Postgres does not create one for a
 * foreign key. The retention sweep deletes conversations 1000 ids at a
 * time, and every deleted row made Postgres scan `agent_runs` and
 * `conversations` again to apply the SET NULL. The per-app sweep also
 * deletes runs by `conversationId IN (...)` directly, which was a third
 * scan per batch.
 */
export class VersionAndConversationIndexes1750795000000 implements MigrationInterface {
  name = 'VersionAndConversationIndexes1750795000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Change History: WHERE "itemType" = $1 AND "itemId" = $2 ORDER BY "timestamp" DESC.
    // DESC in the index so the sort is satisfied by the scan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_version_itemType_itemId_timestamp"
      ON "version" ("itemType", "itemId", "timestamp" DESC)
    `);

    // Retention sweep: SELECT id FROM "version" WHERE "timestamp" < $1 LIMIT $2.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_version_timestamp"
      ON "version" ("timestamp")
    `);

    // agent_runs.conversationId -> conversations, ON DELETE SET NULL.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_runs_conversationId"
      ON "agent_runs" ("conversationId")
    `);

    // conversations.parentConversationId -> conversations, ON DELETE SET NULL.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_conversations_parentConversationId"
      ON "conversations" ("parentConversationId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversations_parentConversationId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_runs_conversationId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_version_timestamp"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_version_itemType_itemId_timestamp"`);
  }
}
