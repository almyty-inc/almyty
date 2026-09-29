import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gateways of every protocol ("tools", made by Share tools) become MCP
 * gateways.
 *
 * A gateway is now created for one protocol. The rows that served MCP,
 * UTCP and Agent Skills at one address keep their id, so their tools,
 * access keys, auth configs, events and address (org slug + endpoint)
 * are unchanged; they answer MCP there from now on. The MCP transport
 * setting the protocol needs is added to the existing configuration.
 */
export class ToolsGatewaysBecomeMcp1750813758000 implements MigrationInterface {
  name = 'ToolsGatewaysBecomeMcp1750813758000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "gateways"
      SET "type" = 'mcp',
          "kind" = 'tool',
          "configuration" = (COALESCE("configuration"::jsonb, '{}'::jsonb) || '{"transport": "http"}'::jsonb)::json
      WHERE "type" = 'tools'
    `);
  }

  public async down(): Promise<void> {
    // Which MCP gateways were once "tools" is not recorded; nothing to undo.
  }
}
