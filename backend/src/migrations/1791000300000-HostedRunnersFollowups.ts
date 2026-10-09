import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hosted runners, the follow-ups decided on 2026-10-08
 * (docs/hosted-runners.md):
 *
 * - `hosted_model_tokens`: the pod-scoped token a coding CLI in a hosted
 *   pod uses on almyty's Anthropic- and OpenAI-compatible endpoints. Only
 *   the sha256 is stored; a token is revoked when its pod stops.
 * - `environments.allowVendorKeys`: whether an environment may put a model
 *   provider's own key into its pods (for a CLI that cannot change its
 *   base URL). Off unless someone turns it on.
 * - `workspaces.leaseHolder` / `leaseJob` / `leaseUntil`: which job holds
 *   a hosted workspace, so the jobs on one person's folder run one after
 *   another.
 * - `retention_policies.runnerUsageDays`: an organization's own retention
 *   for hosted usage records (null: the install's default).
 * - A BEFORE DELETE trigger on teams that makes the team's environments
 *   private, for any delete path the service does not see (the service
 *   does the same first, audited, and tells the owner).
 */
export class HostedRunnersFollowups1791000300000 implements MigrationInterface {
  name = 'HostedRunnersFollowups1791000300000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "hosted_model_tokens" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "hostedRunnerId" uuid NOT NULL REFERENCES "hosted_runners"("id") ON DELETE CASCADE,
        "environmentId" uuid NOT NULL,
        "workspaceId" uuid NOT NULL,
        "ownerUserId" uuid NOT NULL,
        "tokenHash" varchar(64) NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "revokedAt" timestamptz,
        "revokedReason" varchar(32),
        "lastUsedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hosted_model_tokens_hash" ON "hosted_model_tokens" ("tokenHash")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_hosted_model_tokens_live" ON "hosted_model_tokens" ("hostedRunnerId") WHERE "revokedAt" IS NULL`);

    await q.query(`ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "allowVendorKeys" boolean NOT NULL DEFAULT false`);

    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "leaseHolder" uuid`);
    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "leaseJob" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "leaseUntil" timestamptz`);

    await q.query(`ALTER TABLE "retention_policies" ADD COLUMN IF NOT EXISTS "runnerUsageDays" int`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_runner_usage_intervals_org_ended" ON "runner_usage_intervals" ("organizationId", "endedAt") WHERE "endedAt" IS NOT NULL`);

    await q.query(`
      CREATE OR REPLACE FUNCTION teams_privatise_environments_before_delete() RETURNS trigger AS $$
      BEGIN
        UPDATE environments SET visibility = 'private', "teamId" = NULL WHERE "teamId" = OLD.id;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await q.query(`DROP TRIGGER IF EXISTS teams_privatise_environments_before_delete ON teams`);
    await q.query(`
      CREATE TRIGGER teams_privatise_environments_before_delete
        BEFORE DELETE ON teams
        FOR EACH ROW EXECUTE FUNCTION teams_privatise_environments_before_delete()
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS teams_privatise_environments_before_delete ON teams`);
    await q.query(`DROP FUNCTION IF EXISTS teams_privatise_environments_before_delete()`);
    await q.query(`DROP INDEX IF EXISTS "IDX_runner_usage_intervals_org_ended"`);
    await q.query(`ALTER TABLE "retention_policies" DROP COLUMN IF EXISTS "runnerUsageDays"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "leaseUntil"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "leaseJob"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "leaseHolder"`);
    await q.query(`ALTER TABLE "environments" DROP COLUMN IF EXISTS "allowVendorKeys"`);
    await q.query(`DROP TABLE IF EXISTS "hosted_model_tokens"`);
  }
}
