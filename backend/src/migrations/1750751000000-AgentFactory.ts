import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agent Factory: harnesses and their distributions.
 *
 * A harness is the product a customer ships: several agents under one
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
      CREATE TABLE IF NOT EXISTS "harnesses" (
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
        CONSTRAINT "PK_harnesses" PRIMARY KEY ("id")
      )
    `);

    // Unique per organization rather than globally: two customers may
    // both reasonably ship something called "support".
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_harnesses_org_slug"
      ON "harnesses" ("organizationId", "slug")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_harnesses_org_name"
      ON "harnesses" ("organizationId", "name")
    `);
    await queryRunner.query(`
      ALTER TABLE "harnesses"
      ADD CONSTRAINT "FK_harnesses_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "harness_distributions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "harnessId" uuid NOT NULL,
        "target" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'draft',
        "gatewayId" uuid,
        "configuration" json,
        "lastBuild" json,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_harness_distributions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_harness_distributions_harness_target"
      ON "harness_distributions" ("harnessId", "target")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_harness_distributions_org_created"
      ON "harness_distributions" ("organizationId", "createdAt")
    `);
    await queryRunner.query(`
      ALTER TABLE "harness_distributions"
      ADD CONSTRAINT "FK_harness_distributions_harness"
      FOREIGN KEY ("harnessId") REFERENCES "harnesses"("id") ON DELETE CASCADE
    `);
    // A channel distribution points at the gateway holding the platform
    // credentials. Deleting that gateway leaves the distribution intact
    // but unwired, which is recoverable; cascading would silently delete
    // a configured product.
    await queryRunner.query(`
      ALTER TABLE "harness_distributions"
      ADD CONSTRAINT "FK_harness_distributions_gateway"
      FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "harness_distributions" DROP CONSTRAINT IF EXISTS "FK_harness_distributions_gateway"`,
    );
    await queryRunner.query(
      `ALTER TABLE "harness_distributions" DROP CONSTRAINT IF EXISTS "FK_harness_distributions_harness"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_harness_distributions_org_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_harness_distributions_harness_target"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "harness_distributions"`);

    await queryRunner.query(
      `ALTER TABLE "harnesses" DROP CONSTRAINT IF EXISTS "FK_harnesses_organization"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_harnesses_org_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_harnesses_org_slug"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "harnesses"`);
  }
}
