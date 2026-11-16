import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The most tokens a model writes in one reply, from the price feed. An
 * answer checker asks for as much room as its model allows, up to 8,192
 * (agent-verifier.helper.ts checkerOutputLimit).
 */
export class ModelMaxOutputTokens1791001300000 implements MigrationInterface {
  name = 'ModelMaxOutputTokens1791001300000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "maxOutputTokens" integer`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "models" DROP COLUMN IF EXISTS "maxOutputTokens"`);
  }
}
