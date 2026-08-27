import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recursion depth on the run ledger.
 *
 * A run is depth 0. A sub-agent, collaboration member, or any future
 * recursive call is its parent's depth plus one, so nested work is
 * bounded inside the same run-scoped budget instead of starting a fresh
 * one alongside it. `parentRunId` already recorded the edge; this
 * records how far down it goes so the limit resolver can cap it.
 *
 * Backfilled to 0 for existing rows, which is correct: every run that
 * exists today was budgeted as if it were a root.
 */
export class AgentRunRecursionDepth1750748000000 implements MigrationInterface {
  name = 'AgentRunRecursionDepth1750748000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_runs"
      ADD COLUMN IF NOT EXISTS "recursionDepth" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_runs"
      ADD COLUMN IF NOT EXISTS "toolCallCount" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "toolCallCount"`);
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "recursionDepth"`);
  }
}
