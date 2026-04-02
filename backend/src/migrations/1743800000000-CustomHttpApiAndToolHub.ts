import { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomHttpApiAndToolHub1743800000000 implements MigrationInterface {
  name = 'CustomHttpApiAndToolHub1743800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add direct apiId FK on tools
    await queryRunner.query(`
      ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "apiId" uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tools_api_id" ON "tools"("apiId")
    `);

    // Add FK constraint for apiId -> apis(id)
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tools_apiId') THEN
          ALTER TABLE "tools"
          ADD CONSTRAINT "FK_tools_apiId"
          FOREIGN KEY ("apiId") REFERENCES "apis"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // Backfill apiId from operation chain
    await queryRunner.query(`
      UPDATE "tools" t
      SET "apiId" = o."apiId"
      FROM "operations" o
      WHERE t."operationId" = o."id"
      AND t."apiId" IS NULL
    `);

    // Add httpConfig JSON column on tools
    await queryRunner.query(`
      ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "httpConfig" json
    `);

    // Create tool_templates table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(255) NOT NULL,
        "description" text,
        "provider" character varying(100) NOT NULL,
        "providerIcon" character varying(500),
        "category" character varying(100) NOT NULL,
        "tags" text[] DEFAULT '{}',
        "executionMethod" character varying(50) NOT NULL,
        "httpConfig" json,
        "parameters" json NOT NULL DEFAULT '{}',
        "configuration" json NOT NULL DEFAULT '{}',
        "examples" json NOT NULL DEFAULT '[]',
        "apiConfig" json,
        "isBuiltIn" boolean NOT NULL DEFAULT false,
        "organizationId" uuid,
        "visibility" character varying(20) NOT NULL DEFAULT 'public',
        "version" character varying(20) NOT NULL DEFAULT '1.0.0',
        "installCount" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tool_templates" PRIMARY KEY ("id")
      )
    `);

    // Create indexes on tool_templates
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tool_templates_provider" ON "tool_templates"("provider")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tool_templates_category" ON "tool_templates"("category")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tool_templates_org" ON "tool_templates"("organizationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tool_templates_visibility" ON "tool_templates"("visibility")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tool_templates_built_in" ON "tool_templates"("isBuiltIn")`,
    );

    // Add FK constraint for tool_templates.organizationId -> organizations(id)
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_templates_organizationId') THEN
          ALTER TABLE "tool_templates"
          ADD CONSTRAINT "FK_tool_templates_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tool_templates FK and table
    await queryRunner.query(`ALTER TABLE IF EXISTS "tool_templates" DROP CONSTRAINT IF EXISTS "FK_tool_templates_organizationId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tool_templates_built_in"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tool_templates_visibility"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tool_templates_org"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tool_templates_category"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tool_templates_provider"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_templates"`);

    // Drop httpConfig column from tools
    await queryRunner.query(`ALTER TABLE "tools" DROP COLUMN IF EXISTS "httpConfig"`);

    // Drop apiId FK and column from tools
    await queryRunner.query(`ALTER TABLE IF EXISTS "tools" DROP CONSTRAINT IF EXISTS "FK_tools_apiId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tools_api_id"`);
    await queryRunner.query(`ALTER TABLE "tools" DROP COLUMN IF EXISTS "apiId"`);
  }
}
