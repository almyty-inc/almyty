import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSystemGatewayFields1744800000000 implements MigrationInterface {
  name = 'AddSystemGatewayFields1744800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add isSystem flag to gateways — marks auto-provisioned system gateways
    await queryRunner.query(
      `ALTER TABLE "gateways" ADD COLUMN "isSystem" boolean NOT NULL DEFAULT false`,
    );

    // Add isSystemTool flag to tools — marks management tools bound to the system gateway
    await queryRunner.query(
      `ALTER TABLE "tools" ADD COLUMN "isSystemTool" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tools" DROP COLUMN IF EXISTS "isSystemTool"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gateways" DROP COLUMN IF EXISTS "isSystem"`,
    );
  }
}
