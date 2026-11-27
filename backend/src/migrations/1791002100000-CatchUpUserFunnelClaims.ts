import { MigrationInterface, QueryRunner } from 'typeorm';

import { BackfillUserFunnelClaims1791002000000 } from './1791002000000-BackfillUserFunnelClaims';

/**
 * Runs the funnel-claim backfill once more, one release after it.
 *
 * Migrations run before the new API is rolled out. While the release with
 * BackfillUserFunnelClaims1791002000000 rolled out, servers from before
 * it were still confirming addresses and finishing runs without writing
 * the claim, so those accounts kept NULL claims. This pass marks them,
 * with the same rules and NULL-only updates (running it again changes
 * nothing), provided that every server still running when it runs
 * already claims: the previous release finished rolling out first.
 *
 * An install that skips that release, and so runs both migrations before
 * one rollout, does not have that guarantee. It runs
 * scripts/catch-up-funnel-claims.ts after its rollout instead.
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
