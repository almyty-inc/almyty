/**
 * Marks funnel milestones that no server claimed, with the same rules and
 * NULL-only updates as the BackfillUserFunnelClaims1791002000000
 * migration. Safe to run any number of times.
 *
 * For a cluster that upgraded across the release that added the claim
 * (v0.2.51) in one rollout: servers from before it kept confirming
 * addresses and finishing runs without claiming them while the rollout
 * ran. Run this once ALL of those servers (API and workers) are gone and
 * before setting POSTHOG_API_KEY:
 *
 *   node dist-ee/src/scripts/catch-up-funnel-claims.js
 *
 * in an API pod or image, with the same DATABASE_* environment. A
 * migration cannot do this job: the migration ledger runs each one once,
 * before the rollout.
 */
import { DataSource } from 'typeorm';

import { BackfillUserFunnelClaims1791002000000 } from '../migrations/1791002000000-BackfillUserFunnelClaims';

export interface FunnelClaimCounts {
  signupClaimed: number;
  firstRunClaimed: number;
}

async function counts(ds: DataSource): Promise<FunnelClaimCounts> {
  const [row] = await ds.query(
    `SELECT COUNT("signupEventAt")::int AS "signupClaimed", COUNT("firstRunEventAt")::int AS "firstRunClaimed" FROM "users"`,
  );
  return row;
}

/** Runs the catch-up on an initialized data source; returns the claim counts before and after. */
export async function catchUpFunnelClaims(ds: DataSource): Promise<{ before: FunnelClaimCounts; after: FunnelClaimCounts }> {
  const before = await counts(ds);
  const runner = ds.createQueryRunner();
  try {
    await runner.startTransaction();
    await new BackfillUserFunnelClaims1791002000000().up(runner);
    await runner.commitTransaction();
  } catch (err) {
    await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.release();
  }
  return { before, after: await counts(ds) };
}

async function main(): Promise<void> {
  // Loaded here, not at the top: it reads the environment and builds the
  // connection as soon as it is imported.
  const { AppDataSource } = await import('../config/database.config');
  await AppDataSource.initialize();
  try {
    const { before, after } = await catchUpFunnelClaims(AppDataSource);
    console.log(
      `Funnel claims: sign-up ${before.signupClaimed} -> ${after.signupClaimed}, first run ${before.firstRunClaimed} -> ${after.firstRunClaimed}.`,
    );
  } finally {
    await AppDataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Funnel claim catch-up failed: ${(err as Error)?.message}`);
    process.exit(1);
  });
}
