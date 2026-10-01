import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `channel_events.message`: what an inbound message said, as the channel
 * normalized it (its text and the names of its files), so a person's
 * download carries the words of a message that never became a run. Only
 * that, never the platform's delivery; erased and swept with the row.
 */
export class ChannelEventMessage1750813796000 implements MigrationInterface {
  name = 'ChannelEventMessage1750813796000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE channel_events ADD COLUMN IF NOT EXISTS "message" jsonb NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE channel_events DROP COLUMN IF EXISTS "message"`);
  }
}
