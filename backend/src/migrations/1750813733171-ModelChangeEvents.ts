import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Model change notices: one row per model that appeared on, or dropped off,
 * a provider connection (ModelChangeEvent). See model-catalog/notices.
 *
 * The daily digest goes out at 08:00 in each person's own time zone:
 * `users.timezone` (an IANA name; UTC while unset) and
 * `users.modelDigestSentAt` (when their last one went out).
 */
export class ModelChangeEvents1750813733171 implements MigrationInterface {
  name = 'ModelChangeEvents1750813733171';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "model_change_events" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "providerId" uuid NOT NULL,
        "providerName" varchar(255) NOT NULL,
        "modelId" uuid,
        "vendorModelId" varchar(300) NOT NULL,
        "modelName" varchar(300) NOT NULL,
        "kind" varchar(16) NOT NULL,
        "offered" boolean NOT NULL DEFAULT true,
        "reason" text,
        "agentIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "notifiedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_model_change_events_createdAt" ON "model_change_events" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_model_change_events_lookup" ON "model_change_events" ("organizationId", "providerId", "vendorModelId", "kind", "createdAt")`,
    );
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "timezone" varchar(64)`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "modelDigestSentAt" timestamptz`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "modelDigestSentAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "timezone"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "model_change_events"`);
  }
}
