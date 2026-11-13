import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An index on every foreign key a deleted API cascades through.
 *
 * Deleting an API is one DELETE; Postgres then removes its operations,
 * tools, schemas, resources and credentials, and from each tool its
 * versions, and clears the tool from request logs and usage metrics. Where
 * the referencing column had no index, each of those row deletions scanned
 * the whole referencing table: a 21-tool API meant 21 full scans of
 * request_logs and of usage_metrics, 85 of tools, 21 of operations and of
 * tool_versions. On staging that took the delete past three minutes.
 *
 * src/test/integration/api-delete-cascade.integration.spec.ts holds the
 * cascade to no sequential scan at all, and every foreign key it reaches
 * to an index.
 */
const INDEXES: Array<[name: string, table: string, column: string]> = [
  ['IDX_tools_apiId', 'tools', 'apiId'],
  ['IDX_tools_operationId', 'tools', 'operationId'],
  ['IDX_tools_inputSchemaId', 'tools', 'inputSchemaId'],
  ['IDX_tools_outputSchemaId', 'tools', 'outputSchemaId'],
  ['IDX_tool_versions_toolId', 'tool_versions', 'toolId'],
  ['IDX_request_logs_toolId', 'request_logs', 'toolId'],
  ['IDX_usage_metrics_toolId', 'usage_metrics', 'toolId'],
  ['IDX_operations_resourceId', 'operations', 'resourceId'],
  ['IDX_json_schemas_sourceSchemaId', 'json_schemas', 'sourceSchemaId'],
  ['IDX_credentials_apiId', 'credentials', 'apiId'],
  ['IDX_push_subscriptions_apiId', 'push_subscriptions', 'apiId'],
  ['IDX_push_subscriptions_verifyCredentialId', 'push_subscriptions', 'verifyCredentialId'],
  ['IDX_external_agents_credentialId', 'external_agents', 'credentialId'],
];

export class IndexApiDeleteCascadeForeignKeys1791001600000 implements MigrationInterface {
  name = 'IndexApiDeleteCascadeForeignKeys1791001600000';

  public async up(q: QueryRunner): Promise<void> {
    for (const [name, table, column] of INDEXES) {
      await q.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" ("${column}")`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [name] of [...INDEXES].reverse()) {
      await q.query(`DROP INDEX IF EXISTS "${name}"`);
    }
  }
}
