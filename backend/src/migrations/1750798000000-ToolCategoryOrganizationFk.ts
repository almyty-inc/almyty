import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Back the tool_categories tenancy column with a real foreign key.
 *
 * `organizationId` is NOT NULL and every lookup filters on it, but it
 * was `character varying` with no reference to `organizations`, and the
 * entity carried a bare column instead of a relation. That combination
 * is the same one `org_kms_configs` had: the column reads like a
 * tenancy key and behaves like free text, so an `onDelete` declared in
 * the entity would do nothing and a deleted organization would leave
 * its categories behind.
 *
 * Nothing in the backend writes this table, so the column is empty and
 * the type change is a no-op on the data. That is the reason to do it
 * now rather than after something seeds it.
 */
export class ToolCategoryOrganizationFk1750798000000 implements MigrationInterface {
  name = 'ToolCategoryOrganizationFk1750798000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Anything that does not name a real organization cannot be kept
    // once the column is a foreign key. Two statements, because an OR
    // gives Postgres no obligation to evaluate the shape test before
    // the ::uuid cast in the other branch.
    await queryRunner.query(`
      DELETE FROM "tool_categories"
      WHERE "organizationId" IS NULL
         OR "organizationId" !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    `);
    await queryRunner.query(`
      DELETE FROM "tool_categories"
      WHERE "organizationId"::uuid NOT IN (SELECT "id" FROM "organizations")
    `);

    await queryRunner.query(`
      ALTER TABLE "tool_categories"
      ALTER COLUMN "organizationId" TYPE uuid USING "organizationId"::uuid
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_categories_organizationId'
        ) THEN
          ALTER TABLE "tool_categories"
            ADD CONSTRAINT "FK_tool_categories_organizationId"
            FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
        END IF;
      END $$
    `);

    // Every read is scoped by organization; the FK's referencing column
    // needs its own index for the cascade too.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tool_categories_organizationId"
      ON "tool_categories" ("organizationId")
    `);

    // The slug was unique across the whole install. So the first
    // organization to create a "web" category would take that slug away
    // from every other tenant on the deployment — a cross-tenant name
    // collision with no way for the loser to work around it, on a column
    // whose whole purpose is to be a short human-chosen name. Unique per
    // organization is what was meant.
    await queryRunner.query(`
      ALTER TABLE "tool_categories" DROP CONSTRAINT IF EXISTS "UQ_tool_categories_slug"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tool_categories_org_slug"
      ON "tool_categories" ("organizationId", "slug")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_tool_categories_org_slug"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'UQ_tool_categories_slug'
        ) THEN
          ALTER TABLE "tool_categories"
            ADD CONSTRAINT "UQ_tool_categories_slug" UNIQUE ("slug");
        END IF;
      END $$
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tool_categories_organizationId"`);
    await queryRunner.query(`
      ALTER TABLE "tool_categories"
      DROP CONSTRAINT IF EXISTS "FK_tool_categories_organizationId"
    `);
    await queryRunner.query(`
      ALTER TABLE "tool_categories"
      ALTER COLUMN "organizationId" TYPE character varying USING "organizationId"::text
    `);
  }
}
