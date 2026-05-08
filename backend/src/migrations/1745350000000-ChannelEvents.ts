import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChannelEvents1745350000000 implements MigrationInterface {
  name = 'ChannelEvents1745350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS channel_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "gatewayId" UUID NOT NULL,
        "channelType" VARCHAR(32) NOT NULL,
        direction VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        payload JSONB,
        "errorMessage" TEXT,
        "runId" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX channel_events_gateway_idx ON channel_events ("gatewayId", "createdAt" DESC)`);
    await queryRunner.query(`CREATE INDEX channel_events_org_idx ON channel_events ("organizationId", "createdAt" DESC)`);
    // FK to gateways. ON DELETE CASCADE so removing a gateway also
    // drops its event log (avoids orphan rows).
    await queryRunner.query(`
      ALTER TABLE channel_events
      ADD CONSTRAINT channel_events_gateway_fk
      FOREIGN KEY ("gatewayId") REFERENCES gateways (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS channel_events CASCADE`);
  }
}
