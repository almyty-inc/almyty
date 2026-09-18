import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The prompt/completion split of a run's token usage.
 *
 * Providers return `usage.inputTokens` and `usage.outputTokens`, but the
 * node executor kept only `usage.totalTokens` and the engine accumulated
 * that one number — so the OpenAI-compatible route, which must answer with
 * `prompt_tokens` and `completion_tokens`, had nothing honest to report.
 *
 * NOT NULL DEFAULT 0 rather than nullable: a run that predates this column,
 * or one made entirely of tool and transform nodes, genuinely has a split of
 * zero, and a caller summing these should not have to handle a null.
 */
export class AgentExecutionTokenSplit1750806000000 implements MigrationInterface {
  name = 'AgentExecutionTokenSplit1750806000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_executions"
        ADD COLUMN IF NOT EXISTS "inputTokens" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_executions"
        ADD COLUMN IF NOT EXISTS "outputTokens" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_executions" DROP COLUMN IF EXISTS "outputTokens"
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_executions" DROP COLUMN IF EXISTS "inputTokens"
    `);
  }
}
