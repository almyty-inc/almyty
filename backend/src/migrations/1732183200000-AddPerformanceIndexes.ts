import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPerformanceIndexes1732183200000 implements MigrationInterface {
  name = 'AddPerformanceIndexes1732183200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add indexes to Operation entity for apiId queries
    await queryRunner.query(`CREATE INDEX "IDX_operation_apiId" ON "operations" ("apiId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_operation_apiId_isActive" ON "operations" ("apiId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_operation_apiId_deprecated" ON "operations" ("apiId", "deprecated")`,
    );

    // Add indexes to Tool entity for organization and name queries
    await queryRunner.query(
      `CREATE INDEX "IDX_tool_organizationId_name" ON "tools" ("organizationId", "name")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_tool_organizationId_status" ON "tools" ("organizationId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_tool_organizationId_createdAt" ON "tools" ("organizationId", "createdAt")`,
    );

    // Add indexes to GatewayTool entity for tool and gateway queries
    await queryRunner.query(
      `CREATE INDEX "IDX_gateway_tool_toolId_isActive" ON "gateway_tools" ("toolId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_gateway_tool_gatewayId_isActive" ON "gateway_tools" ("gatewayId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_gateway_tool_gatewayId_usageCount" ON "gateway_tools" ("gatewayId", "usageCount")`,
    );

    // Add indexes to Resource entity for apiId queries
    await queryRunner.query(`CREATE INDEX "IDX_resource_apiId" ON "resources" ("apiId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_resource_apiId_type" ON "resources" ("apiId", "type")`,
    );

    // Add indexes to ApiSchema entity for apiId queries
    await queryRunner.query(`CREATE INDEX "IDX_api_schema_apiId" ON "api_schemas" ("apiId")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_api_schema_apiId_version" ON "api_schemas" ("apiId", "version")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove indexes from ApiSchema
    await queryRunner.query(`DROP INDEX "IDX_api_schema_apiId_version"`);
    await queryRunner.query(`DROP INDEX "IDX_api_schema_apiId"`);

    // Remove indexes from Resource
    await queryRunner.query(`DROP INDEX "IDX_resource_apiId_type"`);
    await queryRunner.query(`DROP INDEX "IDX_resource_apiId"`);

    // Remove indexes from GatewayTool
    await queryRunner.query(`DROP INDEX "IDX_gateway_tool_gatewayId_usageCount"`);
    await queryRunner.query(`DROP INDEX "IDX_gateway_tool_gatewayId_isActive"`);
    await queryRunner.query(`DROP INDEX "IDX_gateway_tool_toolId_isActive"`);

    // Remove indexes from Tool
    await queryRunner.query(`DROP INDEX "IDX_tool_organizationId_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_tool_organizationId_status"`);
    await queryRunner.query(`DROP INDEX "IDX_tool_organizationId_name"`);

    // Remove indexes from Operation
    await queryRunner.query(`DROP INDEX "IDX_operation_apiId_deprecated"`);
    await queryRunner.query(`DROP INDEX "IDX_operation_apiId_isActive"`);
    await queryRunner.query(`DROP INDEX "IDX_operation_apiId"`);
  }
}
