import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Model change notices: one row per model that appeared on, or dropped off,
 * a provider connection (ModelChangeEvent). See model-catalog/notices.
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
        "reason" text,
        "agentIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "notifiedAt" timestamptz,
        "digestedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_model_change_events_org_digested" ON "model_change_events" ("organizationId", "digestedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_model_change_events_lookup" ON "model_change_events" ("organizationId", "providerId", "vendorModelId", "kind", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "model_change_events"`);
  }
}
