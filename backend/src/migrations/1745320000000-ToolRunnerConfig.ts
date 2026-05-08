import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `runnerConfig` jsonb to tools so capability publication can
 * mint Tool rows that point at a registered runner. Routing in
 * ToolExecutorService dispatches these through RunnerCallService
 * over the Streamable HTTP envelope flow.
 *
 * Indexed on (runnerConfig->>'runnerId') so unregistration can
 * cascade-delete a runner's published capabilities in a single sweep.
 */
export class ToolRunnerConfig1745320000000 implements MigrationInterface {
  name = 'ToolRunnerConfig1745320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tools ADD COLUMN "runnerConfig" JSONB`);
    await queryRunner.query(`
      CREATE INDEX tools_runner_id_idx
        ON tools (("runnerConfig"->>'runnerId'))
        WHERE "runnerConfig" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS tools_runner_id_idx`);
    await queryRunner.query(`ALTER TABLE tools DROP COLUMN IF EXISTS "runnerConfig"`);
  }
}
