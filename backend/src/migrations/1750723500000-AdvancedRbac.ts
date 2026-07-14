import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EE P5 (advanced_rbac): custom roles + assignments + ABAC policies.
 * The built-in owner/admin/member/viewer roles remain in the OSS core;
 * these tables only carry the enterprise extension and are empty on a
 * community deployment.
 */
export class AdvancedRbac1750723500000 implements MigrationInterface {
  name = 'AdvancedRbac1750723500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS custom_roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        name VARCHAR(64) NOT NULL,
        description TEXT,
        permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        active BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX custom_roles_org_name_idx ON custom_roles ("organizationId", name)`,
    );
    await queryRunner.query(`
      ALTER TABLE custom_roles
      ADD CONSTRAINT custom_roles_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS custom_role_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "userId" UUID NOT NULL,
        "customRoleId" UUID NOT NULL,
        "assignedBy" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX custom_role_assignments_org_user_idx ON custom_role_assignments ("organizationId", "userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX custom_role_assignments_role_user_idx ON custom_role_assignments ("customRoleId", "userId")`,
    );
    await queryRunner.query(`
      ALTER TABLE custom_role_assignments
      ADD CONSTRAINT custom_role_assignments_role_fk
      FOREIGN KEY ("customRoleId") REFERENCES custom_roles (id) ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS abac_policies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        name VARCHAR(128) NOT NULL,
        description TEXT,
        effect VARCHAR(8) NOT NULL DEFAULT 'allow',
        action VARCHAR(128) NOT NULL DEFAULT '*',
        conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
        priority INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX abac_policies_org_active_idx ON abac_policies ("organizationId", active)`,
    );
    await queryRunner.query(`
      ALTER TABLE abac_policies
      ADD CONSTRAINT abac_policies_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS abac_policies CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS custom_role_assignments CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS custom_roles CASCADE`);
  }
}
