import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two columns that let a failure be joined to the thing that failed.
 *
 * request_logs.errorCode: a refused request already carried a stable
 * code on the exception (NO_AUTH, SURFACE_RATE_LIMITED, INVALID_API_KEY)
 * and answered it to the client, but the code had nowhere to land, so
 * counting refusals by reason meant pattern-matching free-text
 * errorMessage — which for every refused gateway request was the literal
 * string "Http Exception".
 *
 * tool_executions.runId: an agent run's step and the tool_executions row
 * it produced had no column in common. A user reporting "the agent said
 * the lookup failed" could not be taken to the row holding the
 * parameters, the upstream status and the error text.
 */
export class RequestErrorCodeAndToolExecutionRun1750803000000 implements MigrationInterface {
  name = 'RequestErrorCodeAndToolExecutionRun1750803000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "request_logs"
        ADD COLUMN IF NOT EXISTS "errorCode" character varying(64)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_request_logs_errorCode"
        ON "request_logs" ("errorCode")
    `);

    await queryRunner.query(`
      ALTER TABLE "tool_executions"
        ADD COLUMN IF NOT EXISTS "runId" uuid
    `);
    // No FK to agent_runs: a tool execution outlives the run it came
    // from (runs are pruned on their own retention schedule) and the
    // column is a correlation handle, not an ownership edge.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tool_executions_runId"
        ON "tool_executions" ("runId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tool_executions_runId"`);
    await queryRunner.query(`
      ALTER TABLE "tool_executions" DROP COLUMN IF EXISTS "runId"
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_request_logs_errorCode"`);
    await queryRunner.query(`
      ALTER TABLE "request_logs" DROP COLUMN IF EXISTS "errorCode"
    `);
  }
}
