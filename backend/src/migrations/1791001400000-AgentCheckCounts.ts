import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two numbers per agent next to "Completed" (runs that finished): the runs
 * whose final answer a checker gave a verdict on, and how many of those
 * passed ("Checks passed"). Counted from the runs already recorded; a run
 * no checker could give a verdict on was not checked and is not counted.
 */
export class AgentCheckCounts1791001400000 implements MigrationInterface {
  name = 'AgentCheckCounts1791001400000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "checkedExecutions" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "passedCheckExecutions" integer NOT NULL DEFAULT 0`);
    await q.query(`
      UPDATE "agents" a SET
        "checkedExecutions" = c.checked,
        "passedCheckExecutions" = c.passed
      FROM (
        SELECT r."agentId"::text AS "agentId",
               COUNT(*)::int AS checked,
               COUNT(*) FILTER (WHERE (r."metadata"::jsonb -> 'verify' ->> 'verdict') = 'pass')::int AS passed
          FROM "agent_runs" r
         WHERE r."status" = 'completed'
           AND (r."metadata"::jsonb -> 'verify' ->> 'verdict') IS NOT NULL
           AND COALESCE(r."metadata"::jsonb -> 'verify' ->> 'unavailable', 'false') <> 'true'
         GROUP BY r."agentId"
      ) c
      WHERE a."id"::text = c."agentId"
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "passedCheckExecutions"`);
    await q.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "checkedExecutions"`);
  }
}
