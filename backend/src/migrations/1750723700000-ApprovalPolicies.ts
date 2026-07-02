import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EE P5 (approval_policy): multi-step / conditional / quorum approval
 * policies. Single-gate approvals (the approval_requests table + one
 * authorized approver) stay OSS; this table layers a declarative policy
 * engine on top and is empty on a community deployment.
 */
export class ApprovalPolicies1750723700000 implements MigrationInterface {
  name = 'ApprovalPolicies1750723700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS approval_policies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        name VARCHAR(128) NOT NULL,
        description TEXT,
        "teamId" UUID,
        match JSONB NOT NULL DEFAULT '[]'::jsonb,
        steps JSONB NOT NULL DEFAULT '[]'::jsonb,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX approval_policies_org_enabled_prio_idx ON approval_policies ("organizationId", enabled, priority DESC)`,
    );
    await queryRunner.query(`
      ALTER TABLE approval_policies
      ADD CONSTRAINT approval_policies_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS approval_policies CASCADE`);
  }
}
