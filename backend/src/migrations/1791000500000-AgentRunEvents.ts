import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable runs, step 1 (docs/design/durable-runs.md): the run event log.
 *
 * - `agent_run_events`: one row per event an autonomous step commit
 *   appends, numbered per run from 1. The primary key (runId, seq) serves
 *   "events after seq N for run R"; the run's delete cascades to them.
 * - `agent_runs.headSeq`: the seq of the run's last event, advanced in the
 *   same transaction as the events and guarded by the commit's CAS.
 */
export class AgentRunEvents1791000500000 implements MigrationInterface {
  name = 'AgentRunEvents1791000500000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "headSeq" integer NOT NULL DEFAULT 0`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "agent_run_events" (
        "runId" uuid NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
        "seq" integer NOT NULL,
        "type" varchar(64) NOT NULL,
        "step" integer,
        "payload" jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_run_events" PRIMARY KEY ("runId", "seq")
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "agent_run_events"`);
    await q.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "headSeq"`);
  }
}
