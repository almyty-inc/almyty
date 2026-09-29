import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which app a run answered for, so an app's spend can be capped.
 *
 * A run started on one of an app's places (web chat, widget, messaging
 * channel, A2A) records the app it belongs to. The app spend cap sums
 * agent_runs.totalCost for the app over the current UTC day and month,
 * so the index leads with the app and ranges over updatedAt; rows no
 * app started stay out of it.
 */
export class AgentRunAppId1750813647000 implements MigrationInterface {
  name = 'AgentRunAppId1750813647000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "appId" uuid`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_runs_appId_updatedAt" ON "agent_runs" ("appId", "updatedAt") WHERE "appId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_runs_appId_updatedAt"`);
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "appId"`);
  }
}
