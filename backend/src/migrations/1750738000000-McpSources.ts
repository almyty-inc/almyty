import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * External MCP servers as tool sources. One row per registered
 * server; discovered remote tools are materialized into the existing
 * tools table (type='mcp' — the tools.type column is a varchar, so
 * no enum change is needed here).
 */
export class McpSources1750738000000 implements MigrationInterface {
  name = 'McpSources1750738000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mcp_sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" VARCHAR NOT NULL,
        "description" VARCHAR,
        "url" VARCHAR NOT NULL,
        "authType" VARCHAR(16) NOT NULL DEFAULT 'none',
        "authConfig" JSON,
        "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        "lastSyncAt" TIMESTAMPTZ,
        "lastError" TEXT,
        "toolCount" INTEGER NOT NULL DEFAULT 0,
        "serverInfo" JSON,
        "organizationId" UUID NOT NULL,
        "createdBy" VARCHAR,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS mcp_sources_org_name_uq ON mcp_sources ("organizationId", "name")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS mcp_sources_org_created_idx ON mcp_sources ("organizationId", "createdAt")`,
    );
    await queryRunner.query(`
      ALTER TABLE mcp_sources
      ADD CONSTRAINT mcp_sources_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS mcp_sources CASCADE`);
  }
}
