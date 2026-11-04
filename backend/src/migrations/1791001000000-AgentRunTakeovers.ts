import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable runs, step 3 (docs/design/durable-runs.md): a cap on takeovers.
 *
 * - `takeovers`: how many times in a row the step a run is at was taken
 *   over from a worker whose lease lapsed, back to 0 when a step commits.
 *   The takeover that reaches RUN_MAX_TAKEOVERS fails the run.
 */
export class AgentRunTakeovers1791001000000 implements MigrationInterface {
  name = 'AgentRunTakeovers1791001000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "takeovers" INTEGER NOT NULL DEFAULT 0`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "takeovers"`);
  }
}
