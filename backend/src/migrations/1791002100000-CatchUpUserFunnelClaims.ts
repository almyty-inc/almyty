import { MigrationInterface, QueryRunner } from 'typeorm';

import { BackfillUserFunnelClaims1791002000000 } from './1791002000000-BackfillUserFunnelClaims';

/**
 * Runs the funnel-claim backfill once more, one release after it.
 *
 * Migrations run before the new API is rolled out. While the release with
 * BackfillUserFunnelClaims1791002000000 rolled out, servers from before
 * it were still confirming addresses and finishing runs without writing
 * the claim, so those accounts kept NULL claims. Every server running when
 * this migration runs writes the claim itself (ProductAnalyticsService
 * claims with or without a PostHog key), so this pass leaves no milestone
 * unmarked. The same rules and the same NULL-only updates as the backfill:
 * running it again changes nothing.
 */
export class CatchUpUserFunnelClaims1791002100000 implements MigrationInterface {
  name = 'CatchUpUserFunnelClaims1791002100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await new BackfillUserFunnelClaims1791002000000().up(queryRunner);
  }

  /** Nothing, for the reason given on the backfill's down(). */
  public async down(): Promise<void> {
    // Intentionally empty.
  }
}
