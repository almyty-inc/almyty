import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One inbound delivery, one agent run.
 *
 * Every hosted channel redelivers: Slack retries any event whose
 * response took longer than three seconds, Telegram repeats an update
 * until it is acknowledged, Twilio and the Bot Framework retry a dropped
 * connection. The channel controller answers 200 before the pipeline
 * runs, so a retry arrives while the first delivery is still in flight —
 * and lands on a different replica, whose active-run-by-thread lookup
 * finds nothing because the run is still being created. One user
 * message produced two runs, two LLM bills and two replies in the
 * thread. Signature verification authenticates a redelivery; it cannot
 * recognize one.
 *
 * `channel_events` now carries the platform's own id for the delivery,
 * and the partial unique index below is the claim on it: the replica
 * that inserts the row first owns the delivery and every other one gets
 * a unique violation and stops. Partial because the NULL that outbound
 * events, rejected events and the id-less channels carry has to stay
 * repeatable.
 */
export class ChannelDeliveryDedupe1750799000000 implements MigrationInterface {
  name = 'ChannelDeliveryDedupe1750799000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE channel_events
        ADD COLUMN IF NOT EXISTS "deliveryId" character varying(255)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_channel_events_gateway_delivery"
      ON channel_events ("gatewayId", "deliveryId")
      WHERE "deliveryId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_channel_events_gateway_delivery"`);
    await queryRunner.query(`ALTER TABLE channel_events DROP COLUMN IF EXISTS "deliveryId"`);
  }
}
