import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Connections layer, gate 2: grants. A connection is used by anything
 * other than its owner only through a `connection_grants` row naming a
 * user, team, role, agent or workspace. `budgetId` is stored for the EE
 * governance module; it is not enforced here.
 */
export class ConnectionGrants1750762000000 implements MigrationInterface {
  name = 'ConnectionGrants1750762000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "connection_grants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "connectionId" uuid NOT NULL,
        "principalType" character varying(16) NOT NULL,
        "principalId" character varying(64) NOT NULL,
        "permission" character varying(8) NOT NULL DEFAULT 'use',
        "budgetId" uuid,
        "grantedBy" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_connection_grants" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_connection_grants_principal_type"
          CHECK ("principalType" IN ('user', 'team', 'role', 'agent', 'workspace')),
        CONSTRAINT "CHK_connection_grants_permission"
          CHECK ("permission" IN ('use', 'manage'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_connection_grants_connection_principal"
      ON "connection_grants" ("connectionId", "principalType", "principalId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_connection_grants_org_principal"
      ON "connection_grants" ("organizationId", "principalType", "principalId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_connection_grants_budget"
      ON "connection_grants" ("budgetId")
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_connection_grants_connection') THEN
          ALTER TABLE "connection_grants"
          ADD CONSTRAINT "FK_connection_grants_connection"
          FOREIGN KEY ("connectionId") REFERENCES "credentials"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_connection_grants_organization') THEN
          ALTER TABLE "connection_grants"
          ADD CONSTRAINT "FK_connection_grants_organization"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_connection_grants_budget') THEN
          ALTER TABLE "connection_grants"
          ADD CONSTRAINT "FK_connection_grants_budget"
          FOREIGN KEY ("budgetId") REFERENCES "spend_budgets"("id") ON DELETE SET NULL;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "connection_grants"`);
  }
}
