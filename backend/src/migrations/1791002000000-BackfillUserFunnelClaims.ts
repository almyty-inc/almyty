import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marks every account that already exists as counted for the two funnel
 * events (modules/product-analytics), so only people who sign up or first
 * run an agent from here on are reported as new.
 *
 * Without it, an account older than UserFunnelAnalytics1791001900000 has
 * NULL claims: its next completed run would send `first_run_succeeded`, and
 * confirming a changed email address would send `signup_completed`, as if
 * the person had just arrived.
 *
 * - `firstRunEventAt`: the earliest completed run of one of the org's own
 *   agents, the same rules ProductAnalyticsService.runSucceeded applies:
 *   the agent is not `isTemporary` and has no `metadata.sampleWorkspace`
 *   (onboarding/real-activation.ts), and the run counts for the user who
 *   started it, else for the agent's creator. Autonomous runs
 *   (`agent_runs`) and workflow executions (`agent_executions`) both
 *   count. Neither table records a completion time, so the row's
 *   `updatedAt` (last written when it completed) stands in for it. An
 *   agent deleted since has no row left to judge, so its runs count for
 *   nobody.
 * - `signupEventAt`: when the address was confirmed, or now, for every
 *   account that is confirmed (`verifiedAt` or the older `isVerified`
 *   flag), has signed in, or has a run from the step above. An account
 *   that exists but was never confirmed nor used still counts when it is
 *   confirmed: its sign-up completes then. An account whose address is
 *   being changed (both flags reset by changeEmail) but which has signed
 *   in before is caught by `lastLoginAt`.
 *
 * Only NULL claims are touched; a claim already made is kept.
 */
export class BackfillUserFunnelClaims1791002000000 implements MigrationInterface {
  name = 'BackfillUserFunnelClaims1791002000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "users" u
         SET "firstRunEventAt" = first_run."at"
        FROM (
          SELECT runs."who", MIN(runs."at") AS "at"
            FROM (
              SELECT COALESCE(r."userId"::text, a."createdBy"::text) AS "who", r."updatedAt"::timestamptz AS "at"
                FROM "agent_runs" r
                JOIN "agents" a ON a."id"::text = r."agentId"::text
               WHERE r."status" = 'completed'
                 AND a."isTemporary" IS NOT TRUE
                 AND (a."metadata" IS NULL OR a."metadata"->>'sampleWorkspace' IS NULL)
              UNION ALL
              SELECT COALESCE(e."userId"::text, a."createdBy"::text), e."updatedAt"::timestamptz
                FROM "agent_executions" e
                JOIN "agents" a ON a."id"::text = e."agentId"::text
               WHERE e."status" = 'completed'
                 AND a."isTemporary" IS NOT TRUE
                 AND (a."metadata" IS NULL OR a."metadata"->>'sampleWorkspace' IS NULL)
            ) runs
           WHERE runs."who" IS NOT NULL
           GROUP BY runs."who"
        ) first_run
       WHERE u."id"::text = first_run."who"
         AND u."firstRunEventAt" IS NULL
    `);

    await queryRunner.query(`
      UPDATE "users"
         SET "signupEventAt" = COALESCE("verifiedAt", now())
       WHERE "signupEventAt" IS NULL
         AND ("verifiedAt" IS NOT NULL
              OR "isVerified" = true
              OR "lastLoginAt" IS NOT NULL
              OR "firstRunEventAt" IS NOT NULL)
    `);
  }

  /**
   * Nothing. The backfilled values are indistinguishable from claims the
   * service made afterwards (both are plain timestamps, and nothing records
   * which rows this migration wrote), so clearing them would also clear
   * real claims and let those events go out a second time. Rolling back
   * UserFunnelAnalytics1791001900000 drops the columns altogether.
   */
  public async down(): Promise<void> {
    // Intentionally empty, see above.
  }
}
