import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameLlmMessageToMessage1744300000000 implements MigrationInterface {
  name = 'RenameLlmMessageToMessage1744300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rename table
    await queryRunner.query(`ALTER TABLE "llm_messages" RENAME TO "messages"`);

    // Rename sessionId → conversationId
    await queryRunner.query(`ALTER TABLE "messages" RENAME COLUMN "sessionId" TO "conversationId"`);

    // Add new columns
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "externalMessageId" text`);
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "parts" jsonb`);
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "runId" uuid`);

    // Add indexes
    await queryRunner.query(`CREATE INDEX "IDX_messages_conversationId_createdAt" ON "messages" ("conversationId", "createdAt" DESC)`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_messages_externalMessageId_unique" ON "messages" ("conversationId", "externalMessageId") WHERE "externalMessageId" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_messages_runId" ON "messages" ("runId") WHERE "runId" IS NOT NULL`);

    // FK for runId
    await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_runId" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE SET NULL`);

    // Update existing FK to point at conversations table (the FK referencing llm_sessions
    // was auto-renamed by Postgres when the table was renamed, but the constraint name
    // still references the old name — drop and re-add cleanly)
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "FK_llm_messages_sessionId"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "FK_messages_conversationId"`);

    // Rename old indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_llm_messages_sessionId_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_llm_messages_role_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_llm_messages_status_createdAt"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "FK_messages_runId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_runId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_externalMessageId_unique"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_conversationId_createdAt"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "runId"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "parts"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "externalMessageId"`);
    await queryRunner.query(`ALTER TABLE "messages" RENAME COLUMN "conversationId" TO "sessionId"`);
    await queryRunner.query(`ALTER TABLE "messages" RENAME TO "llm_messages"`);
  }
}
