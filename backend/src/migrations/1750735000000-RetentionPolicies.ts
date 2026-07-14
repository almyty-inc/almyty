import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Org-scoped configurable data retention. One row per organization
 * (unique); a missing row — and every NULL day-count — means "keep
 * forever", so existing orgs keep today's behavior until an admin
 * configures a policy.
 */
export class RetentionPolicies1750735000000 implements MigrationInterface {
  name = 'RetentionPolicies1750735000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS retention_policies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "agentRunsDays" INTEGER,
        "conversationsDays" INTEGER,
        "requestLogsDays" INTEGER,
        "usageMetricsDays" INTEGER,
        "auditLogDays" INTEGER,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS retention_policies_org_uq ON retention_policies ("organizationId")`,
    );
    await queryRunner.query(`
      ALTER TABLE retention_policies
      ADD CONSTRAINT retention_policies_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS retention_policies CASCADE`);
  }
}
