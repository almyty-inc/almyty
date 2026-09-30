import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An agent's gateways go with the agent.
 *
 * `gateways.agentId` was ON DELETE SET NULL, so deleting an agent left its
 * web chat, widget and messaging gateways behind with no agent: still
 * active, still holding their addresses (a new web chat for the same name
 * got "-2"), and answering a message with a 500. Deleting an agent now
 * deletes its gateways through the channel service first (webhooks taken
 * down, credentials released); the foreign key cascades for any path that
 * deletes an agent without it. Only agent gateways carry an agentId, so a
 * tool gateway is never touched.
 *
 * Agent gateways already left without an agent are deleted here.
 */
export class AgentGatewaysGoWithAgent1750813783000 implements MigrationInterface {
  name = 'AgentGatewaysGoWithAgent1750813783000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "gateways" WHERE "kind" = 'agent' AND "agentId" IS NULL`);
    await queryRunner.query(`ALTER TABLE "gateways" DROP CONSTRAINT IF EXISTS "FK_gateways_agentId"`);
    await queryRunner.query(
      `ALTER TABLE "gateways" ADD CONSTRAINT "FK_gateways_agentId" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "gateways" DROP CONSTRAINT IF EXISTS "FK_gateways_agentId"`);
    await queryRunner.query(
      `ALTER TABLE "gateways" ADD CONSTRAINT "FK_gateways_agentId" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL`,
    );
  }
}
