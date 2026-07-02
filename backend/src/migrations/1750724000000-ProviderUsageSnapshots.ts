import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * External provider usage ingestion (P7). `provider_usage_snapshots`
 * stores the authoritative usage/cost pulled from an LLM provider's own
 * usage API (OpenAI Usage/Costs, Anthropic Usage & Cost report), one row
 * per (provider, day) bucket. This is the *provider-actual* side of the
 * Cost-tab reconciliation against our internal estimate.
 *
 * The unique index on (organizationId, llmProviderId, periodStart) makes
 * the fetch-and-store path an idempotent upsert.
 *
 * The optional per-provider `usageApiKey` (a DIFFERENT credential scope —
 * OpenAI admin key / Anthropic org-admin key) lives inside the existing
 * `llm_providers.configuration` JSON column, so no column is added for it
 * here.
 */
export class ProviderUsageSnapshots1750724000000 implements MigrationInterface {
  name = 'ProviderUsageSnapshots1750724000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS provider_usage_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "llmProviderId" UUID NOT NULL,
        "providerType" VARCHAR NOT NULL,
        "periodStart" TIMESTAMPTZ NOT NULL,
        "periodEnd" TIMESTAMPTZ NOT NULL,
        "inputTokens" BIGINT NOT NULL DEFAULT 0,
        "outputTokens" BIGINT NOT NULL DEFAULT 0,
        "totalTokens" BIGINT NOT NULL DEFAULT 0,
        "costCents" INTEGER NOT NULL DEFAULT 0,
        "currency" VARCHAR(8) NOT NULL DEFAULT 'usd',
        "source" VARCHAR(16) NOT NULL DEFAULT 'provider',
        "raw" JSON,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX provider_usage_snapshots_org_period_idx
       ON provider_usage_snapshots ("organizationId", "periodStart")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX provider_usage_snapshots_upsert_idx
       ON provider_usage_snapshots ("organizationId", "llmProviderId", "periodStart")`,
    );
    await queryRunner.query(`
      ALTER TABLE provider_usage_snapshots
      ADD CONSTRAINT provider_usage_snapshots_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE provider_usage_snapshots
      ADD CONSTRAINT provider_usage_snapshots_provider_fk
      FOREIGN KEY ("llmProviderId") REFERENCES llm_providers (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS provider_usage_snapshots CASCADE`,
    );
  }
}
