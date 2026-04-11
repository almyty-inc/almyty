import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameLlmSessionToConversation1744200000000 implements MigrationInterface {
  name = 'RenameLlmSessionToConversation1744200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rename table
    await queryRunner.query(`ALTER TABLE "llm_sessions" RENAME TO "conversations"`);

    // Make providerId nullable (conversations can belong to agents or external agents)
    await queryRunner.query(`ALTER TABLE "conversations" ALTER COLUMN "providerId" DROP NOT NULL`);

    // Add new FK columns
    await queryRunner.query(`ALTER TABLE "conversations" ADD COLUMN "agentId" uuid`);
    await queryRunner.query(`ALTER TABLE "conversations" ADD COLUMN "externalAgentId" uuid`);
    await queryRunner.query(`ALTER TABLE "conversations" ADD COLUMN "parentConversationId" uuid`);

    // Drop the type column (no longer needed; the FK tells you the kind)
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "type"`);

    // Simplify status: collapse TIMEOUT into failed (timeout is run-level)
    await queryRunner.query(`UPDATE "conversations" SET "status" = 'failed' WHERE "status" = 'timeout'`);

    // Add FK constraints (externalAgentId FK deferred to Phase 6 when that table exists)
    await queryRunner.query(`ALTER TABLE "conversations" ADD CONSTRAINT "FK_conversations_agentId" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL`);
    await queryRunner.query(`ALTER TABLE "conversations" ADD CONSTRAINT "FK_conversations_parentConversationId" FOREIGN KEY ("parentConversationId") REFERENCES "conversations"("id") ON DELETE SET NULL`);

    // Rename indexes to match new table name
    await queryRunner.query(`ALTER INDEX IF EXISTS "IDX_llm_sessions_providerId_status" RENAME TO "IDX_conversations_providerId_status"`);
    await queryRunner.query(`ALTER INDEX IF EXISTS "IDX_llm_sessions_gatewayId_status" RENAME TO "IDX_conversations_gatewayId_status"`);
    await queryRunner.query(`ALTER INDEX IF EXISTS "IDX_llm_sessions_organizationId_createdAt" RENAME TO "IDX_conversations_organizationId_createdAt"`);
    await queryRunner.query(`ALTER INDEX IF EXISTS "IDX_llm_sessions_userId_createdAt" RENAME TO "IDX_conversations_userId_createdAt"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "FK_conversations_parentConversationId"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "FK_conversations_agentId"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "parentConversationId"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "externalAgentId"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "agentId"`);
    await queryRunner.query(`ALTER TABLE "conversations" ADD COLUMN "type" varchar NOT NULL DEFAULT 'chat'`);
    await queryRunner.query(`ALTER TABLE "conversations" ALTER COLUMN "providerId" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "conversations" RENAME TO "llm_sessions"`);
  }
}
