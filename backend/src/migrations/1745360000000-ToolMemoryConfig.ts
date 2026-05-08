import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2: memory operations as published Tool rows.
 *
 * Adds `memoryConfig` jsonb to tools (mirroring runnerConfig from
 * cluster 5.5). When set, ToolExecutorService dispatches the tool by
 * calling CanonicalMemoryService directly with the configured method
 * + canonical scope. MemoryCapabilityPublisher mints rows for the
 * standard ops (store_memory / recall_memory / list_memories /
 * search_memories) on demand.
 */
export class ToolMemoryConfig1745360000000 implements MigrationInterface {
  name = 'ToolMemoryConfig1745360000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tools ADD COLUMN IF NOT EXISTS "memoryConfig" JSONB`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS tools_memory_method_idx
        ON tools (("memoryConfig"->>'method'))
        WHERE "memoryConfig" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS tools_memory_method_idx`);
    await queryRunner.query(`ALTER TABLE tools DROP COLUMN IF EXISTS "memoryConfig"`);
  }
}
