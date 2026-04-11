import { MigrationInterface, QueryRunner } from 'typeorm';

export class GatewayKindAndAgent1744500000000 implements MigrationInterface {
  name = 'GatewayKindAndAgent1744500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add kind column (tool or agent)
    await queryRunner.query(`ALTER TABLE "gateways" ADD COLUMN "kind" varchar NOT NULL DEFAULT 'tool'`);

    // Add agentId FK for agent-kind gateways
    await queryRunner.query(`ALTER TABLE "gateways" ADD COLUMN "agentId" uuid`);
    await queryRunner.query(`ALTER TABLE "gateways" ADD CONSTRAINT "FK_gateways_agentId" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_gateways_agentId" ON "gateways" ("agentId") WHERE "agentId" IS NOT NULL`);

    // Delete any existing a2a-type rows (pre-launch, no real data)
    await queryRunner.query(`DELETE FROM "gateways" WHERE "type" = 'a2a'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_gateways_agentId"`);
    await queryRunner.query(`ALTER TABLE "gateways" DROP CONSTRAINT IF EXISTS "FK_gateways_agentId"`);
    await queryRunner.query(`ALTER TABLE "gateways" DROP COLUMN IF EXISTS "agentId"`);
    await queryRunner.query(`ALTER TABLE "gateways" DROP COLUMN IF EXISTS "kind"`);
  }
}
