import { MigrationInterface } from 'typeorm';

/**
 * Does nothing. Apps do not exist: ChannelsOnTheAgent1750813742000 drops
 * their tables, and a channel gateway belongs to an agent's channel.
 */
export class EveryChatSurfaceHasAnApp1750812800000 implements MigrationInterface {
  name = 'EveryChatSurfaceHasAnApp1750812800000';

  public async up(): Promise<void> {}

  public async down(): Promise<void> {}
}
