import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A workspace an agent run was given automatically says which agent and
 * which run it is for, and carries the folder name the runner made.
 *
 * - `agentId` references agents and is nulled when the agent is deleted,
 *   so the workspace row stays for audit.
 * - `runId` is an autonomous run or a workflow execution, two tables, so
 *   it has no foreign key.
 * - At most one active workspace per (run, runner): two tool calls of the
 *   same run racing for a folder converge on one row
 *   (RunWorkspaceService.acquire).
 */
export class WorkspacesForAgentRuns1750813764000 implements MigrationInterface {
  name = 'WorkspacesForAgentRuns1750813764000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workspaces" ADD COLUMN "name" TEXT`);
    await queryRunner.query(`ALTER TABLE "workspaces" ADD COLUMN "agentId" UUID`);
    await queryRunner.query(`ALTER TABLE "workspaces" ADD COLUMN "runId" UUID`);
    await queryRunner.query(
      `ALTER TABLE "workspaces" ADD CONSTRAINT "FK_workspaces_agent" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_workspaces_agentId" ON "workspaces" ("agentId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workspaces_active_run_runner" ON "workspaces" ("runId", "runnerId") WHERE "status" = 'active' AND "runId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_workspaces_active_run_runner"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_workspaces_agentId"`);
    await queryRunner.query(`ALTER TABLE "workspaces" DROP CONSTRAINT IF EXISTS "FK_workspaces_agent"`);
    await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "runId"`);
    await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "agentId"`);
    await queryRunner.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "name"`);
  }
}
