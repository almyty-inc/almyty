import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EE P5 (audit_export): per-org SIEM streaming targets. The basic
 * audit-log write/query path stays OSS; this table only configures
 * outbound forwarding (webhook / Splunk HEC / Datadog) and is empty on
 * a community deployment.
 */
export class AuditStreamConfig1750723650000 implements MigrationInterface {
  name = 'AuditStreamConfig1750723650000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS audit_stream_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        target VARCHAR(32) NOT NULL,
        endpoint TEXT NOT NULL,
        token TEXT,
        "actionFilter" JSONB,
        enabled BOOLEAN NOT NULL DEFAULT true,
        "lastDeliveredAt" TIMESTAMPTZ,
        "lastError" TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX audit_stream_configs_org_enabled_idx ON audit_stream_configs ("organizationId", enabled)`,
    );
    await queryRunner.query(`
      ALTER TABLE audit_stream_configs
      ADD CONSTRAINT audit_stream_configs_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS audit_stream_configs CASCADE`);
  }
}
