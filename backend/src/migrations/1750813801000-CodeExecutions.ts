import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Code-mode traces (docs/design/code-mode.md, part C, and decision 13):
 * one `code_executions` row per `run_code`, holding the script, its logs,
 * return value, status, timing, CPU time and change set; and
 * `tool_executions.codeExecutionId`, so every call a script made is an
 * ordinary tool execution row that can be joined to its script. Deleting a
 * script's row leaves its calls in place (set null): they are the audit of
 * what ran.
 */
export class CodeExecutions1750813801000 implements MigrationInterface {
  name = 'CodeExecutions1750813801000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "code_executions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "runId" uuid,
        "agentId" uuid,
        "gatewayId" uuid,
        "userId" uuid,
        "code" text NOT NULL,
        "logs" text NOT NULL DEFAULT '',
        "result" jsonb,
        "error" jsonb,
        "status" varchar(24) NOT NULL DEFAULT 'running',
        "changeSet" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "approvalRequestId" uuid,
        "callCount" integer NOT NULL DEFAULT 0,
        "cpuMs" integer NOT NULL DEFAULT 0,
        "durationMs" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_code_executions_status" CHECK ("status" IN ('running', 'completed', 'failed', 'waiting_approval', 'approved', 'rejected'))
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_code_executions_org_created" ON "code_executions" ("organizationId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_code_executions_run" ON "code_executions" ("runId")`);
    await queryRunner.query(`ALTER TABLE "tool_executions" ADD COLUMN IF NOT EXISTS "codeExecutionId" uuid`);
    await queryRunner.query(
      `ALTER TABLE "tool_executions" ADD CONSTRAINT "FK_tool_executions_code_execution" FOREIGN KEY ("codeExecutionId") REFERENCES "code_executions"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_executions_code_execution" ON "tool_executions" ("codeExecutionId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tool_executions_code_execution"`);
    await queryRunner.query(`ALTER TABLE "tool_executions" DROP CONSTRAINT IF EXISTS "FK_tool_executions_code_execution"`);
    await queryRunner.query(`ALTER TABLE "tool_executions" DROP COLUMN IF EXISTS "codeExecutionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "code_executions"`);
  }
}
