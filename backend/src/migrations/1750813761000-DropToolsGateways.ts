import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each gateway serves one protocol, and no code serves the `tools` type.
 * Gateways of that type are deleted, with their tool attachments and access
 * keys; every other row that points at a gateway cascades or is nulled by
 * its foreign key.
 */
export class DropToolsGateways1750813761000 implements MigrationInterface {
  name = 'DropToolsGateways1750813761000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "gateway_tools" WHERE "gatewayId" IN (SELECT "id" FROM "gateways" WHERE "type" = 'tools')`);
    await queryRunner.query(`DELETE FROM "api_keys" WHERE "gatewayId" IN (SELECT "id" FROM "gateways" WHERE "type" = 'tools')`);
    await queryRunner.query(`DELETE FROM "gateways" WHERE "type" = 'tools'`);
  }

  public async down(): Promise<void> {
    // Deleted rows are not restored.
  }
}
