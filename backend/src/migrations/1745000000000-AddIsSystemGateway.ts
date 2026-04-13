import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsSystemGateway1745000000000 implements MigrationInterface {
  name = 'AddIsSystemGateway1745000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add isSystem column to gateways table
    await queryRunner.query(`
      ALTER TABLE "gateways" ADD COLUMN IF NOT EXISTS "isSystem" boolean NOT NULL DEFAULT false
    `);

    // Create a system gateway for every existing organization that doesn't have one
    await queryRunner.query(`
      INSERT INTO "gateways" ("id", "name", "description", "type", "kind", "status", "organizationId", "endpoint", "configuration", "isSystem", "requestTimeout", "maxRetries", "isHealthy")
      SELECT uuid_generate_v4(), 'almyty', 'almyty platform management tools', 'mcp', 'tool', 'active', id, '/almyty', '{"transport":"http"}', true, 30000, 3, true
      FROM "organizations"
      WHERE NOT EXISTS (
        SELECT 1 FROM "gateways" WHERE "organizationId" = "organizations"."id" AND "endpoint" = '/almyty' AND "isSystem" = true
      )
    `);

    // Create OAuth auth config for each system gateway
    await queryRunner.query(`
      INSERT INTO "gateway_auth" ("id", "gatewayId", "type", "isRequired", "isActive", "configuration", "validationRules", "errorResponses")
      SELECT uuid_generate_v4(), g."id", 'oauth2', true, true, '{}', '{}', '{}'
      FROM "gateways" g
      WHERE g."isSystem" = true
      AND NOT EXISTS (
        SELECT 1 FROM "gateway_auth" WHERE "gatewayId" = g."id" AND "type" = 'oauth2'
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove OAuth auth configs for system gateways
    await queryRunner.query(`
      DELETE FROM "gateway_auth" WHERE "gatewayId" IN (
        SELECT "id" FROM "gateways" WHERE "isSystem" = true
      )
    `);

    // Remove system gateways
    await queryRunner.query(`
      DELETE FROM "gateways" WHERE "isSystem" = true
    `);

    // Drop column
    await queryRunner.query(`
      ALTER TABLE "gateways" DROP COLUMN IF EXISTS "isSystem"
    `);
  }
}
