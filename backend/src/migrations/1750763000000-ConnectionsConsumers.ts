import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Connections layer, gate 3: every consumer that used to keep a third
 * party secret in its own row points at a Credential row instead.
 *
 * - llm_providers.credentialId already existed (InitialSchema); the
 *   inference key moves there. usageCredentialId is the admin/usage key,
 *   a different scope at the vendor and therefore a second row.
 * - mcp_sources.credentialId replaces authConfig.
 * - channel_installations.credentialId replaces the per-workspace
 *   credentials blob.
 * - apis keep their reference in credentials.apiId (unchanged); the
 *   inline authentication.config secrets move into such a row.
 *
 * The old columns stay for the read-through shims and the startup
 * backfill (ConsumerSecretBackfillService); nothing is dropped here.
 */
export class ConnectionsConsumers1750763000000 implements MigrationInterface {
  name = 'ConnectionsConsumers1750763000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "credentialId" uuid`);
    await queryRunner.query(`ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "usageCredentialId" uuid`);
    await this.foreignKey(queryRunner, 'llm_providers', 'credentialId', 'FK_llm_providers_credentialId');
    await this.foreignKey(queryRunner, 'llm_providers', 'usageCredentialId', 'FK_llm_providers_usageCredentialId');
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_llm_providers_credentialId" ON "llm_providers" ("credentialId")`);

    await queryRunner.query(`ALTER TABLE "mcp_sources" ADD COLUMN IF NOT EXISTS "credentialId" uuid`);
    await this.foreignKey(queryRunner, 'mcp_sources', 'credentialId', 'FK_mcp_sources_credentialId');
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mcp_sources_credentialId" ON "mcp_sources" ("credentialId")`);

    await queryRunner.query(`ALTER TABLE "channel_installations" ADD COLUMN IF NOT EXISTS "credentialId" uuid`);
    await this.foreignKey(queryRunner, 'channel_installations', 'credentialId', 'FK_channel_installations_credentialId');
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_channel_installations_credentialId" ON "channel_installations" ("credentialId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "channel_installations" DROP CONSTRAINT IF EXISTS "FK_channel_installations_credentialId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channel_installations_credentialId"`);
    await queryRunner.query(`ALTER TABLE "channel_installations" DROP COLUMN IF EXISTS "credentialId"`);

    await queryRunner.query(`ALTER TABLE "mcp_sources" DROP CONSTRAINT IF EXISTS "FK_mcp_sources_credentialId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mcp_sources_credentialId"`);
    await queryRunner.query(`ALTER TABLE "mcp_sources" DROP COLUMN IF EXISTS "credentialId"`);

    await queryRunner.query(`ALTER TABLE "llm_providers" DROP CONSTRAINT IF EXISTS "FK_llm_providers_usageCredentialId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_llm_providers_credentialId"`);
    await queryRunner.query(`ALTER TABLE "llm_providers" DROP COLUMN IF EXISTS "usageCredentialId"`);
    // llm_providers.credentialId predates this migration and stays.
  }

  private async foreignKey(queryRunner: QueryRunner, table: string, column: string, name: string): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
          ALTER TABLE "${table}"
          ADD CONSTRAINT "${name}"
          FOREIGN KEY ("${column}") REFERENCES "credentials"("id") ON DELETE SET NULL;
        END IF;
      END $$
    `);
  }
}
