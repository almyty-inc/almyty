import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sync gateway.kind from gateway.type for all existing rows.
 *
 * kind was a stored column that could get out of sync with type.
 * Now kind is always derived from type (via @BeforeInsert/@BeforeUpdate),
 * but existing rows may have wrong values (e.g., ACP gateways with
 * kind='tool' instead of kind='agent').
 */
export class SyncGatewayKindFromType1745280000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Tool-kind types
    await queryRunner.query(`
      UPDATE gateways
      SET kind = 'tool'
      WHERE type IN ('mcp', 'utcp', 'skills')
        AND kind != 'tool'
    `);

    // Everything else is agent-kind
    await queryRunner.query(`
      UPDATE gateways
      SET kind = 'agent'
      WHERE type NOT IN ('mcp', 'utcp', 'skills')
        AND kind != 'agent'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No rollback — previous values were incorrect
  }
}
