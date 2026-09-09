import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Connections layer, gate 1: a Credential row becomes a connection when
 * it carries a connectorKey (plus the account it resolves to and its
 * health), and org admins can define their own connectors.
 *
 * No second table for connections: secrets keep living in exactly one
 * place. The `connectors` table only holds org-defined catalog entries.
 */
export class Connections1750761000000 implements MigrationInterface {
  name = 'Connections1750761000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "connectorKey" character varying`);
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "ownerUserId" uuid`);
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "accountLabel" character varying`);
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "healthStatus" character varying(16) NOT NULL DEFAULT 'unknown'`);
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "healthCheckedAt" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "healthError" text`);
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "scopesGranted" json`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_credentials_org_connector" ON "credentials" ("organizationId", "connectorKey")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_credentials_owner_user" ON "credentials" ("ownerUserId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "connectors" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "key" character varying(64) NOT NULL,
        "kind" character varying(32) NOT NULL,
        "displayName" character varying(120) NOT NULL,
        "definition" json NOT NULL,
        "createdBy" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_connectors" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_connectors_org_key" ON "connectors" ("organizationId", "key")`);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_connectors_organization') THEN
          ALTER TABLE "connectors"
          ADD CONSTRAINT "FK_connectors_organization"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "connectors"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_credentials_owner_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_credentials_org_connector"`);
    for (const col of ['scopesGranted', 'healthError', 'healthCheckedAt', 'healthStatus', 'accountLabel', 'ownerUserId', 'connectorKey']) {
      await queryRunner.query(`ALTER TABLE "credentials" DROP COLUMN IF EXISTS "${col}"`);
    }
  }
}
