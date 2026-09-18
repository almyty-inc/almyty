import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One schema row per (api, version).
 *
 * The schema import is enqueued with attempts: 3, and tool generation
 * runs after the import transaction commits and re-throws on failure —
 * so a tool-gen failure retries the whole import from the top. The
 * schema insert was unconditional and nothing but non-unique indexes
 * stood behind it, so three attempts meant three copies of the raw
 * spec (7-12 MB each on Stripe/GitHub-class documents) for one
 * version, with version-pinned reads resolving to an arbitrary row.
 *
 * The importer now upserts on (apiId, version); this index is what
 * makes that hold under two importers running at once.
 */
export class SchemaImportIdempotency1750801000000 implements MigrationInterface {
  name = 'SchemaImportIdempotency1750801000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fold any duplicates already written, keeping the oldest row so
    // json_schemas rows and any id-pinned read still resolve.
    await queryRunner.query(`
      DELETE FROM api_schemas a
       USING api_schemas b
       WHERE a."apiId" = b."apiId"
         AND a."version" = b."version"
         AND (a."createdAt" > b."createdAt"
              OR (a."createdAt" = b."createdAt" AND a.id > b.id))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS api_schemas_api_version_uq
      ON api_schemas ("apiId", "version")
    `);
    // The non-unique index it replaces is now redundant.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_api_schemas_apiId_version"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_api_schemas_apiId_version"
      ON "api_schemas" ("apiId", "version")
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS api_schemas_api_version_uq`);
  }
}
