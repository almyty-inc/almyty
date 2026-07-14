import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EE P5 (compliance_pack): the org-scoped enforced-plugin policy that the
 * OSS built-in pii-filter + security-scanner run under. One row per org
 * (unique), empty on a community deployment. Only the feature logic is
 * EE — the table stays in the core schema so the migration runner + entity
 * glob don't need the ee/ tree present.
 */
export class CompliancePolicies1750727100000 implements MigrationInterface {
  name = 'CompliancePolicies1750727100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS compliance_policies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "enforcedPlugins" JSONB NOT NULL DEFAULT '[]'::jsonb,
        "securityThreshold" VARCHAR(16) NOT NULL DEFAULT 'medium',
        "blockOnViolation" BOOLEAN NOT NULL DEFAULT true,
        "piiCategories" JSONB NOT NULL DEFAULT '[]'::jsonb,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS compliance_policies_org_uq ON compliance_policies ("organizationId")`,
    );
    await queryRunner.query(`
      ALTER TABLE compliance_policies
      ADD CONSTRAINT compliance_policies_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS compliance_policies CASCADE`);
  }
}
