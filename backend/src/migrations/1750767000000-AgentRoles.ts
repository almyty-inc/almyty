import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agent roles: a named slot with a requirement and a binding.
 *
 * The model an agent uses currently lives on each node, which is why
 * moving an agent to a different model means editing the graph. A role
 * makes that a binding change instead. Nodes reference a role by key and
 * the existing per-node model field stays valid, so nothing has to move.
 *
 * Reversible: down drops the table and nothing else, because no existing
 * column is altered.
 */
export class AgentRoles1750767000000 implements MigrationInterface {
  name = 'AgentRoles1750767000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_roles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "agentId" uuid NOT NULL,
        "key" character varying(64) NOT NULL,
        "displayName" character varying(128) NOT NULL,
        "requirement" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "binding" jsonb NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_roles" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_roles_org_agent" ON "agent_roles" ("organizationId", "agentId")`,
    );
    // One role key per agent: a node references a key, so two rows sharing
    // one would make that reference ambiguous.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_agent_roles_agent_key" ON "agent_roles" ("agentId", "key")`,
    );
    await queryRunner.query(`
      ALTER TABLE "agent_roles"
      ADD CONSTRAINT "FK_agent_roles_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_roles" DROP CONSTRAINT IF EXISTS "FK_agent_roles_organization"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_agent_roles_agent_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_roles_org_agent"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_roles"`);
  }
}
