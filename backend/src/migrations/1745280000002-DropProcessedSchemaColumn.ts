import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop api_schemas.processedSchema. The parsed form is derivable
 * from rawSchema via the parser at any time, and the operations /
 * resources tables already store the structural data the runtime
 * needs. Keeping a third copy as a fat JSON column on every schema
 * row was 8-15 MB of duplicate state per import — pure cost for
 * a "pretty view" the UI calls maybe once per API.
 *
 * Callers that want a parsed view now hit the on-demand parse
 * endpoint, which runs the parser against rawSchema for the row
 * they care about (~300 ms for a 50 MB WSDL) — paid only when
 * someone actually clicks "view parsed", not on every import.
 */
export class DropProcessedSchemaColumn1745280000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so the migration is idempotent against fresh
    // installs that synced via TypeORM (NestJS dev mode) before
    // the column was removed from the entity.
    await queryRunner.query(`
      ALTER TABLE api_schemas DROP COLUMN IF EXISTS "processedSchema";
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-add as nullable JSON. We can't recover the prior parsed
    // values — they'd need to be re-derived by re-running the
    // parser against rawSchema. Callers that downgrade should
    // run the on-demand parse endpoint to repopulate per row,
    // or simply rely on rawSchema (which the UI's fallback chain
    // already handles).
    await queryRunner.query(`
      ALTER TABLE api_schemas ADD COLUMN IF NOT EXISTS "processedSchema" json;
    `);
  }
}
