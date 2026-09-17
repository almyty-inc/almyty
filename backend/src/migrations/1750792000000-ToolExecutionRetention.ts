import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A retention window for tool_executions.
 *
 * Every other per-event table has one; this table had none, and it is
 * the one that grows fastest in bytes per row -- each execution keeps
 * `parameters` and `result` as untruncated json, and the HTTP executor
 * allows 10MB responses. A tool returning a 2MB payload once a minute
 * writes ~2.8GB a day that nothing ever deleted.
 *
 * Null means keep forever, matching the other columns, so existing
 * installs keep their current behaviour until somebody sets a window.
 */
export class ToolExecutionRetention1750792000000 implements MigrationInterface {
  name = 'ToolExecutionRetention1750792000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE retention_policies
      ADD COLUMN IF NOT EXISTS "toolExecutionsDays" integer
    `);

    // The sweep deletes by (organizationId, createdAt); without this it
    // is a sequential scan over the largest table in the schema.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS tool_executions_org_created_idx
      ON tool_executions ("organizationId", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS tool_executions_org_created_idx`);
    await queryRunner.query(`ALTER TABLE retention_policies DROP COLUMN IF EXISTS "toolExecutionsDays"`);
  }
}
