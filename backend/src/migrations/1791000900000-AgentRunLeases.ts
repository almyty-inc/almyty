import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable runs, step 3 (docs/design/durable-runs.md): run leases.
 *
 * - `nextWakeAt`: when the run next needs a worker (now while it is going,
 *   the wake time of a sleep, null while it waits on a person or once it
 *   has finished). The partial index holds only runs with a time, which is
 *   what the wake sweep reads.
 * - `leaseOwner` / `leaseExpiresAt`: the lease the worker processing a
 *   step holds the run by, and when it lapses unless renewed.
 * - `attempt`: how many times the run was taken over from a worker whose
 *   lease lapsed.
 */
export class AgentRunLeases1791000900000 implements MigrationInterface {
  name = 'AgentRunLeases1791000900000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "nextWakeAt" TIMESTAMPTZ`);
    await q.query(`ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "leaseOwner" VARCHAR(255)`);
    await q.query(`ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMPTZ`);
    await q.query(`ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "attempt" INTEGER NOT NULL DEFAULT 0`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_agent_runs_nextWakeAt" ON "agent_runs" ("nextWakeAt") WHERE "nextWakeAt" IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_agent_runs_nextWakeAt"`);
    await q.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "attempt"`);
    await q.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "leaseExpiresAt"`);
    await q.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "leaseOwner"`);
    await q.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "nextWakeAt"`);
  }
}
