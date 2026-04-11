import { MigrationInterface, QueryRunner } from 'typeorm';

export class AgentRunConversationLink1744400000000 implements MigrationInterface {
  name = 'AgentRunConversationLink1744400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add conversationId to agent_runs
    await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN "conversationId" uuid`);
    await queryRunner.query(`ALTER TABLE "agent_runs" ADD CONSTRAINT "FK_agent_runs_conversationId" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_agent_runs_conversationId" ON "agent_runs" ("conversationId") WHERE "conversationId" IS NOT NULL`);

    // Drop the thread column (data moves to messages table)
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "thread"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN "thread" json NOT NULL DEFAULT '[]'`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_runs_conversationId"`);
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "FK_agent_runs_conversationId"`);
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "conversationId"`);
  }
}
