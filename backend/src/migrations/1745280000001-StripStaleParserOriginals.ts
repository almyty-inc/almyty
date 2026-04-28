import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Strip the redundant raw-schema duplicates that pre-fix parsers
 * left nested inside api_schemas.processedSchema.metadata.
 *
 * Background: GraphQL/SOAP/Protobuf parsers used to attach the
 * full original schema to ParsedSchema.metadata under
 * `originalSchema` / `originalWSDL` / `originalProto`. Nothing
 * downstream reads them and `api_schemas.rawSchema` already
 * holds the authoritative original text. The parsers no longer
 * emit those keys, but rows imported before the fix still carry
 * them — and on a 50 MB WSDL the nested xml2js tree can be
 * 200-300 MB inside one JSON column. This migration removes the
 * stale keys; the rest of metadata is untouched.
 */
export class StripStaleParserOriginals1745280000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE api_schemas
      SET "processedSchema" = (
        ("processedSchema"::jsonb
          #- '{metadata,originalProto}'
          #- '{metadata,originalWSDL}'
          #- '{metadata,originalSchema}'
        )::json
      )
      WHERE "processedSchema" IS NOT NULL
        AND ("processedSchema"::jsonb ? 'metadata')
        AND (
          "processedSchema"::jsonb -> 'metadata' ?| array['originalProto','originalWSDL','originalSchema']
        );
    `);
  }

  public async down(): Promise<void> {
    // No rollback — the stripped values were redundant copies of
    // api_schemas.rawSchema (or the parsed WSDL tree). The raw
    // column is the source of truth; reconstructing the parsed
    // copies would mean re-running the parser, which the runtime
    // can do on demand.
  }
}
