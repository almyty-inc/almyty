import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A tool call an approval policy's amount rule held, from a caller that
 * cannot pause for a person: a workflow agent, a gateway or MCP call, the
 * tool's Test button. It waits in Approvals as a request with no run
 * (runId, and agentId outside an agent, are null), identified by the tool
 * and a fingerprint of the call's parameters; once approved the call runs
 * once (`resultAt` is claimed first) and what it returned is kept on the
 * request (`result`) for the caller who retries with the approval id.
 *
 * `agent_runs.deliveredAt` is when a scheduled autonomous run's result was
 * handed on to the channel or webhook its schedule named, claimed before
 * the post so a run finished twice is posted once.
 */
export class HeldToolCalls1750813791000 implements MigrationInterface {
  name = 'HeldToolCalls1750813791000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "approval_requests" ALTER COLUMN "runId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "approval_requests" ALTER COLUMN "agentId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "toolId" uuid NULL`);
    await queryRunner.query(`ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "fingerprint" varchar(64) NULL`);
    await queryRunner.query(`ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "result" jsonb NULL`);
    await queryRunner.query(`ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "resultAt" timestamptz NULL`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_approval_requests_held_call" ON "approval_requests" ("organizationId", "toolId", "fingerprint") WHERE "toolId" IS NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "deliveredAt" timestamptz NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "deliveredAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_approval_requests_held_call"`);
    await queryRunner.query(`ALTER TABLE "approval_requests" DROP COLUMN IF EXISTS "resultAt"`);
    await queryRunner.query(`ALTER TABLE "approval_requests" DROP COLUMN IF EXISTS "result"`);
    await queryRunner.query(`ALTER TABLE "approval_requests" DROP COLUMN IF EXISTS "fingerprint"`);
    await queryRunner.query(`ALTER TABLE "approval_requests" DROP COLUMN IF EXISTS "toolId"`);
    await queryRunner.query(`DELETE FROM "approval_requests" WHERE "runId" IS NULL OR "agentId" IS NULL`);
    await queryRunner.query(`ALTER TABLE "approval_requests" ALTER COLUMN "agentId" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "approval_requests" ALTER COLUMN "runId" SET NOT NULL`);
  }
}
