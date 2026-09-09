import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Models layer: the catalog (model cards), the registry (versions), the
 * deployments (desired vs actual) and the interim eval scores.
 *
 * Enums are varchar columns, as everywhere else in this schema. Config
 * blobs are json; secrets inside model_deployments.providerConfig are
 * encrypted in place by the entity before save.
 */
export class ModelsLayer1750760000000 implements MigrationInterface {
  name = 'ModelsLayer1750760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "model_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "registryUri" character varying NOT NULL,
        "base" character varying NOT NULL,
        "sizeBytes" bigint,
        "quantizations" character varying[] NOT NULL DEFAULT '{}',
        "lineage" json,
        "evalScores" json,
        "manifestSha" character varying,
        "metadata" json,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_model_versions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_model_versions_org_base" ON "model_versions" ("organizationId", "base")`);
    await queryRunner.query(`
      ALTER TABLE "model_versions"
      ADD CONSTRAINT "FK_model_versions_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "models" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "providerId" uuid,
        "providerType" character varying,
        "vendorModelId" character varying NOT NULL,
        "endpointRef" json,
        "base" character varying,
        "modelVersionId" uuid,
        "capabilities" json NOT NULL DEFAULT '{}',
        "contextLength" integer,
        "pricing" json,
        "pricingSource" character varying NOT NULL DEFAULT 'unpriced',
        "pricingFetchedAt" TIMESTAMP,
        "pricingOverride" json,
        "measuredLatencyMs" json,
        "privacyTier" character varying NOT NULL DEFAULT 'public',
        "region" character varying,
        "status" character varying NOT NULL DEFAULT 'active',
        "validationStatus" character varying NOT NULL DEFAULT 'never',
        "lastValidatedAt" TIMESTAMP,
        "lastValidationError" text,
        "metadata" json,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_models" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_models_org_status" ON "models" ("organizationId", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_models_org_provider" ON "models" ("organizationId", "providerId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_models_org_vendor_model" ON "models" ("organizationId", "vendorModelId")`);
    await queryRunner.query(`
      ALTER TABLE "models"
      ADD CONSTRAINT "FK_models_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "models"
      ADD CONSTRAINT "FK_models_provider"
      FOREIGN KEY ("providerId") REFERENCES "llm_providers"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "models"
      ADD CONSTRAINT "FK_models_model_version"
      FOREIGN KEY ("modelVersionId") REFERENCES "model_versions"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "model_deployments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "modelVersionId" uuid NOT NULL,
        "modelId" uuid,
        "providerType" character varying NOT NULL,
        "desired" json NOT NULL DEFAULT '{}',
        "providerConfig" json NOT NULL DEFAULT '{}',
        "externalRef" json,
        "actual" json,
        "state" character varying NOT NULL DEFAULT 'pending',
        "lastReconcileAt" TIMESTAMP,
        "lastError" text,
        "budgetId" uuid,
        "createdBy" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_model_deployments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_model_deployments_org_state" ON "model_deployments" ("organizationId", "state")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_model_deployments_org_version" ON "model_deployments" ("organizationId", "modelVersionId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_model_deployments_provider_state" ON "model_deployments" ("providerType", "state")`);
    await queryRunner.query(`
      ALTER TABLE "model_deployments"
      ADD CONSTRAINT "FK_model_deployments_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "model_deployments"
      ADD CONSTRAINT "FK_model_deployments_model_version"
      FOREIGN KEY ("modelVersionId") REFERENCES "model_versions"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "model_deployments"
      ADD CONSTRAINT "FK_model_deployments_model"
      FOREIGN KEY ("modelId") REFERENCES "models"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "model_deployments"
      ADD CONSTRAINT "FK_model_deployments_budget"
      FOREIGN KEY ("budgetId") REFERENCES "spend_budgets"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "model_eval_scores" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "modelVersionId" uuid NOT NULL,
        "suite" character varying NOT NULL,
        "score" numeric(8,4) NOT NULL,
        "passed" boolean NOT NULL,
        "runRef" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_model_eval_scores" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_model_eval_scores_org_version_suite" ON "model_eval_scores" ("organizationId", "modelVersionId", "suite")`);
    await queryRunner.query(`
      ALTER TABLE "model_eval_scores"
      ADD CONSTRAINT "FK_model_eval_scores_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "model_eval_scores"
      ADD CONSTRAINT "FK_model_eval_scores_model_version"
      FOREIGN KEY ("modelVersionId") REFERENCES "model_versions"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "model_eval_scores" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "model_deployments" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "models" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "model_versions" CASCADE`);
  }
}
