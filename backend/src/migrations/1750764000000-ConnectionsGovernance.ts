import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Connections governance (EE): org-wide policy rules over the
 * Connections layer. One row per rule; `rule` is validated per `kind`
 * by the EE module before it is stored.
 */
export class ConnectionsGovernance1750764000000 implements MigrationInterface {
  name = 'ConnectionsGovernance1750764000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "connection_policies" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "kind" character varying(32) NOT NULL,
        "name" character varying(128),
        "rule" json NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdBy" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_connection_policies" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_connection_policies_org_kind_enabled" ON "connection_policies" ("organizationId", "kind", "enabled")`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_connection_policies_organization') THEN
          ALTER TABLE "connection_policies"
            ADD CONSTRAINT "FK_connection_policies_organization"
            FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "connection_policies"`);
  }
}
