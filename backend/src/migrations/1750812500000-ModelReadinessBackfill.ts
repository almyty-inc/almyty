import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Brings model cards made before the readiness rule in step with it
 * (docs/models.md, "Readiness"), and stops calling Ollama Cloud free.
 *
 * 1. A provider's models are usable once its key check has passed. Cards
 *    a sync imported before that rule (when a model was usable only after
 *    a check of its own) are still waiting (`validationStatus = 'never'`)
 *    under providers whose check passed long ago, so the Models page
 *    showed "Key works" over a list of "Not available". Each of those is
 *    marked checked exactly as ModelCatalogService.applyProviderCheck
 *    marks one: `passed`, `metadata.checkedBy = 'provider_check'`. A card
 *    that failed on its own (the vendor said the model is gone) keeps its
 *    failure. The same pass also runs at every boot and page load
 *    (reconcileReadiness); this is the one that fixes the rows now.
 *
 * 2. Every Ollama card was priced at $0 with source `native` and filed as
 *    `local`. That holds for a server someone runs, not for Ollama Cloud
 *    (ollama.com), which bills by plan: its cards go back to unpriced
 *    (shown as "Price unknown") and `public`. A price someone typed in
 *    (`pricingOverride`) is left alone.
 *
 * Both statements only touch rows still in the old state, so running the
 * migration twice changes nothing. `down()` does nothing: the old state
 * was the defect.
 */
export class ModelReadinessBackfill1750812500000 implements MigrationInterface {
  name = 'ModelReadinessBackfill1750812500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "models" m
      SET "validationStatus" = 'passed',
          "lastValidatedAt" = now(),
          "lastValidationError" = NULL,
          "metadata" = (COALESCE(m."metadata"::jsonb, '{}'::jsonb) || '{"checkedBy":"provider_check"}'::jsonb)::json
      FROM "llm_providers" p
      WHERE m."providerId" = p."id"
        AND m."organizationId" = p."organizationId"
        AND m."validationStatus" = 'never'
        AND p."status" = 'active'
        AND p."isHealthy" = true
        AND p."lastHealthCheckAt" IS NOT NULL
    `);
    await queryRunner.query(`
      UPDATE "models" m
      SET "pricing" = NULL,
          "pricingSource" = 'unpriced',
          "privacyTier" = CASE WHEN m."privacyTier" = 'local' THEN 'public' ELSE m."privacyTier" END
      FROM "llm_providers" p
      WHERE m."providerId" = p."id"
        AND p."type" = 'ollama'
        AND m."pricingOverride" IS NULL
        AND m."pricingSource" = 'native'
        AND substring(lower(COALESCE(p."configuration"::jsonb ->> 'apiUrl', '')) FROM '^[a-z]+://([^/:?#]+)') ~ '(^|\\.)ollama\\.com$'
    `);
  }

  public async down(): Promise<void> {
    // A data fix: the state before it was the defect, so there is nothing to put back.
  }
}
