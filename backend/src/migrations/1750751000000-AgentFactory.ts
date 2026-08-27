import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agent Factory: apps and their distributions.
 *
 * An app is the product a customer ships: several agents under one
 * name, with the branding they appear under, who is allowed to use
 * them, and what the resulting artifact may touch on the machine it
 * runs on. Distributions are that same product rendered for different
 * places.
 *
 * Kept out of `gateways` on purpose. A gateway receives traffic and
 * carries an endpoint, a status and request counters; a terminal app or
 * a signed binary receives nothing and would inherit a dozen columns
 * that could never mean anything.
 */
export class AgentFactory1750751000000 implements MigrationInterface {
  name = 'AgentFactory1750751000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_apps" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "slug" character varying NOT NULL,
        "description" text,
        "agentIds" uuid[] NOT NULL DEFAULT '{}',
        "branding" json,
        "authMode" character varying NOT NULL DEFAULT 'public_link',
        "capabilities" json,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_apps" PRIMARY KEY ("id")
      )
    `);

    // Unique per organization rather than globally: two customers may
    // both reasonably ship something called "support".
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_agent_apps_org_slug"
      ON "agent_apps" ("organizationId", "slug")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_apps_org_name"
      ON "agent_apps" ("organizationId", "name")
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_apps"
      ADD CONSTRAINT "FK_agent_apps_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_app_distributions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "appId" uuid NOT NULL,
        "target" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'draft',
        "gatewayId" uuid,
        "configuration" json,
        "lastBuild" json,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_app_distributions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_app_distributions_app_target"
      ON "agent_app_distributions" ("appId", "target")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_app_distributions_org_created"
      ON "agent_app_distributions" ("organizationId", "createdAt")
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_app_distributions"
      ADD CONSTRAINT "FK_agent_app_distributions_app"
      FOREIGN KEY ("appId") REFERENCES "agent_apps"("id") ON DELETE CASCADE
    `);
    // A channel distribution points at the gateway holding the platform
    // credentials. Deleting that gateway leaves the distribution intact
    // but unwired, which is recoverable; cascading would silently delete
    // a configured product.
    await queryRunner.query(`
      ALTER TABLE "agent_app_distributions"
      ADD CONSTRAINT "FK_agent_app_distributions_gateway"
      FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_app_distributions" DROP CONSTRAINT IF EXISTS "FK_agent_app_distributions_gateway"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_app_distributions" DROP CONSTRAINT IF EXISTS "FK_agent_app_distributions_app"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_app_distributions_org_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_app_distributions_app_target"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_app_distributions"`);

    await queryRunner.query(
      `ALTER TABLE "agent_apps" DROP CONSTRAINT IF EXISTS "FK_agent_apps_organization"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_apps_org_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_agent_apps_org_slug"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_apps"`);
  }
}
