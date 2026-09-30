import { MigrationInterface } from 'typeorm';

/**
 * Does nothing. Apps do not exist: ChannelsOnTheAgent1750813742000 drops
 * their tables, and a channel gateway belongs to an agent's channel.
 */
export class EveryWidgetAndA2aHasAnApp1750812900000 implements MigrationInterface {
  name = 'EveryWidgetAndA2aHasAnApp1750812900000';

  public async up(): Promise<void> {}

  public async down(): Promise<void> {}
}
