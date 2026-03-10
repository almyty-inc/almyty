import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSecurityColumns1741600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add definitionHash to tools for integrity verification
    await queryRunner.query(`
      ALTER TABLE "tools"
      ADD COLUMN IF NOT EXISTS "definitionHash" VARCHAR(64) NULL
    `);

    // Add securityPolicy to gateway_tools for per-tool security constraints
    await queryRunner.query(`
      ALTER TABLE "gateway_tools"
      ADD COLUMN IF NOT EXISTS "securityPolicy" JSON NULL
    `);

    // Add gatewayId to tool_executions for audit tracking
    await queryRunner.query(`
      ALTER TABLE "tool_executions"
      ADD COLUMN IF NOT EXISTS "gatewayId" UUID NULL
    `);

    // Add index on gatewayId for tool_executions
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tool_executions_gatewayId"
      ON "tool_executions" ("gatewayId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tool_executions_gatewayId"`);
    await queryRunner.query(`ALTER TABLE "tool_executions" DROP COLUMN IF EXISTS "gatewayId"`);
    await queryRunner.query(`ALTER TABLE "gateway_tools" DROP COLUMN IF EXISTS "securityPolicy"`);
    await queryRunner.query(`ALTER TABLE "tools" DROP COLUMN IF EXISTS "definitionHash"`);
  }
}
