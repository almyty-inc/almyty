import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema for publishing a tool into the tool hub.
 *
 * `visibility` goes. Who can see a template is decided entirely by
 * `organizationId` -- NULL is public, a value is that tenant's alone --
 * and every read path in ToolHubService keys off that column. The
 * `visibility` column was written by its own `'public'` default and read
 * by nothing, which meant every org-private row carried the literal
 * string 'public'. A second, wrong source of truth for the highest
 * severity decision in the codebase is worse than no second source.
 *
 * `createdBy` and `sourceToolId` record provenance for a published
 * template. `sourceToolId` is deliberately not a foreign key with
 * CASCADE: deleting the tool a template came from must not retract a
 * template other organizations have already installed.
 *
 * The two partial unique indexes give an owner one template per name.
 * They are partial rather than one plain (organizationId, name) index
 * because Postgres treats NULLs as distinct, so public rows -- the ones
 * every tenant sees -- would otherwise be unconstrained.
 */
export class ToolTemplatePublishing1750807000000 implements MigrationInterface {
  name = 'ToolTemplatePublishing1750807000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tool_templates" DROP COLUMN IF EXISTS "visibility"
    `);
    await queryRunner.query(`
      ALTER TABLE "tool_templates" ADD COLUMN IF NOT EXISTS "createdBy" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "tool_templates" ADD COLUMN IF NOT EXISTS "sourceToolId" uuid
    `);

    // Collapse any duplicate names an owner already holds before the
    // unique indexes go on, otherwise index creation fails outright.
    await queryRunner.query(`
      DELETE FROM "tool_templates" t
      USING "tool_templates" keep
      WHERE t."organizationId" IS NOT NULL
        AND keep."organizationId" = t."organizationId"
        AND keep."name" = t."name"
        AND keep."createdAt" < t."createdAt"
    `);
    await queryRunner.query(`
      DELETE FROM "tool_templates" t
      USING "tool_templates" keep
      WHERE t."organizationId" IS NULL
        AND keep."organizationId" IS NULL
        AND keep."name" = t."name"
        AND keep."createdAt" < t."createdAt"
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "tool_templates_org_name_uq"
        ON "tool_templates" ("organizationId", "name")
        WHERE "organizationId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "tool_templates_public_name_uq"
        ON "tool_templates" ("name")
        WHERE "organizationId" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tool_templates_sourceToolId"
        ON "tool_templates" ("sourceToolId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tool_templates_sourceToolId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "tool_templates_public_name_uq"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "tool_templates_org_name_uq"`);
    await queryRunner.query(`
      ALTER TABLE "tool_templates" DROP COLUMN IF EXISTS "sourceToolId"
    `);
    await queryRunner.query(`
      ALTER TABLE "tool_templates" DROP COLUMN IF EXISTS "createdBy"
    `);
    await queryRunner.query(`
      ALTER TABLE "tool_templates"
        ADD COLUMN IF NOT EXISTS "visibility" character varying(20) NOT NULL DEFAULT 'public'
    `);
  }
}
