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
 *
 * Built CONCURRENTLY, so request_logs, usage_metrics, tools and the rest
 * keep taking writes while each index builds. That cannot run inside a
 * transaction, hence `transaction = false` (the data sources run
 * migrations in 'each' mode, which allows it). A concurrent build that was
 * interrupted (the deploy's migration step timing out, say) leaves an
 * INVALID index behind under the same name, which IF NOT EXISTS would then
 * skip; such a leftover is dropped and built again.
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
  ['IDX_llm_providers_usageCredentialId', 'llm_providers', 'usageCredentialId'],
];

export class IndexApiDeleteCascadeForeignKeys1791001600000 implements MigrationInterface {
  name = 'IndexApiDeleteCascadeForeignKeys1791001600000';
  transaction = false as const;

  public async up(q: QueryRunner): Promise<void> {
    for (const [name, table, column] of INDEXES) {
      // to_regclass resolves on the search_path, like the statements below.
      const invalid = await q.query(
        `SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass($1) AND NOT i.indisvalid`,
        [`"${name}"`],
      );
      if (invalid.length > 0) await q.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
      await q.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${table}" ("${column}")`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [name] of [...INDEXES].reverse()) {
      await q.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    }
  }
}