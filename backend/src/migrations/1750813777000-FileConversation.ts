import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A file someone sent in a conversation belongs to that conversation.
 *
 * Channel and web chat attachments are stored as files and referenced from
 * the message they came with. `conversationId` is what the retention sweep
 * and visitor erasure find them by, so a file goes when its conversation
 * goes; the foreign key cascades the row for any path that deletes the
 * conversation without asking the files module first (the stored object is
 * removed by the paths that do ask).
 */
export class FileConversation1750813777000 implements MigrationInterface {
  name = 'FileConversation1750813777000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "conversationId" uuid NULL`);
    await queryRunner.query(
      `ALTER TABLE "files" ADD CONSTRAINT "FK_files_conversation" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_files_conversationId" ON "files" ("conversationId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_files_conversationId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "FK_files_conversation"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "conversationId"`);
  }
}
