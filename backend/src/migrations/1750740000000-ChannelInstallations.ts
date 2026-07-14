import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-workspace channel installations: one channel gateway (e.g. a
 * Slack app deployment) installable into unlimited external workspaces
 * via OAuth. Each install stores the workspace's own credentials
 * (encrypted at the field level) keyed by the platform tenant id
 * (Slack team_id — generic so Teams multi-tenant can reuse the table).
 */
export class ChannelInstallations1750740000000 implements MigrationInterface {
  name = 'ChannelInstallations1750740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS channel_installations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "gatewayId" UUID NOT NULL,
        "organizationId" UUID NOT NULL,
        "externalTenantId" VARCHAR NOT NULL,
        "credentials" JSONB,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "metadata" JSONB,
        "installedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS channel_installations_gateway_tenant_uq
       ON channel_installations ("gatewayId", "externalTenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS channel_installations_org_created_idx
       ON channel_installations ("organizationId", "createdAt")`,
    );
    await queryRunner.query(`
      ALTER TABLE channel_installations
      ADD CONSTRAINT channel_installations_gateway_fk
      FOREIGN KEY ("gatewayId") REFERENCES gateways (id) ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE channel_installations
      ADD CONSTRAINT channel_installations_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS channel_installations CASCADE`);
  }
}
