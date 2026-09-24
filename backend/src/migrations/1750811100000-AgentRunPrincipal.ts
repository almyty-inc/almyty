import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `agent_runs.principal`: whose scope an autonomous run executes in.
 *
 * A run's steps are processed later, by a queue worker, and every nested
 * step (a child run, a tool call) is authorized against the scope of
 * whoever started the run -- a user, or the gateway it came through.
 * `userId` cannot carry that: a run started through a published gateway
 * has no user, and its scope is the gateway's. Nullable; a row without it
 * is authorized as its `userId`.
 */
export class AgentRunPrincipal1750811100000 implements MigrationInterface {
  name = 'AgentRunPrincipal1750811100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "principal" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "principal"`);
  }
}
