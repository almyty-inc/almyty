import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hosted runners, phase 2 (docs/hosted-runners.md,
 * docs/design/hosted-runners-and-always-on.md):
 *
 * - `environments`: a machine an organization describes once.
 * - `hosted_runners`: the provisioner's desired and actual state per pod.
 * - `runner_enrollment_tokens`: single-use tickets a pod trades for its
 *   runner credential (only the sha256 is stored).
 * - `runner_usage_intervals`: the minutes a pod ran, as observed.
 * - `runners.kind` (`self` | `hosted`) and `runners.hostedRunnerId`; the
 *   one-runner-per-account index applies to `self` only.
 * - `workspaces.kind` (`job` | `persistent`), `environmentId`,
 *   `volumeRef`, `lastActiveAt`, `expiryNoticeAt`, and the non-terminal
 *   `suspended` status.
 *
 * Safe on existing data: every existing runner becomes `self` and every
 * existing workspace `job`, so the narrowed unique index covers exactly
 * the rows the old one did (UQ_runners_owner_org was already satisfied),
 * and the new indexes start over empty tables or columns. New tables use
 * TEXT + CHECK rather than Postgres enums, like the runner tables.
 */
export class HostedRunners1791000200000 implements MigrationInterface {
  name = 'HostedRunners1791000200000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "environments" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "ownerUserId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "visibility" varchar(8) NOT NULL DEFAULT 'private',
        "teamId" uuid,
        "name" varchar(64) NOT NULL,
        "description" text,
        "repo" jsonb,
        "image" jsonb NOT NULL,
        "setupScript" text,
        "envBindings" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "cache" jsonb NOT NULL DEFAULT '{"paths":[]}'::jsonb,
        "egress" jsonb NOT NULL DEFAULT '{"allowHosts":[]}'::jsonb,
        "resourceClass" varchar(16) NOT NULL,
        "idleTimeoutMinutes" int NOT NULL,
        "clusterConnectionId" uuid,
        "version" int NOT NULL DEFAULT 1,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz,
        CONSTRAINT "CHK_environments_visibility" CHECK (
          ("visibility" = 'team' AND "teamId" IS NOT NULL) OR ("visibility" IN ('private', 'org') AND "teamId" IS NULL)
        ),
        CONSTRAINT "CHK_environments_idle" CHECK ("idleTimeoutMinutes" > 0),
        CONSTRAINT "CHK_environments_version" CHECK ("version" > 0)
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_environments_org" ON "environments" ("organizationId")`);
    // Names are unique among live environments of an organization: they
    // become part of tool names, and a deleted one frees its name.
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_environments_org_name" ON "environments" ("organizationId", "name") WHERE "deletedAt" IS NULL`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "hosted_runners" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "environmentId" uuid NOT NULL REFERENCES "environments"("id") ON DELETE CASCADE,
        "environmentVersion" int NOT NULL,
        "workspaceId" uuid NOT NULL,
        "runnerId" uuid,
        "providerType" varchar(32) NOT NULL,
        "desired" jsonb NOT NULL,
        "providerConfig" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "externalRef" jsonb,
        "actual" jsonb,
        "state" varchar(16) NOT NULL DEFAULT 'pending',
        "lastActiveAt" timestamptz,
        "lastReconcileAt" timestamptz,
        "lastError" text,
        "createdBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_hosted_runners_state" CHECK ("state" IN (
          'pending', 'provisioning', 'ready', 'suspending', 'suspended', 'failed', 'tearing_down', 'torn_down', 'orphaned'
        ))
      )
    `);
    // One pod per workspace, while it is not finished.
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hosted_runners_workspace" ON "hosted_runners" ("workspaceId") WHERE "state" NOT IN ('torn_down', 'orphaned')`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_hosted_runners_org_state" ON "hosted_runners" ("organizationId", "state")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_hosted_runners_environment" ON "hosted_runners" ("environmentId")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_hosted_runners_sweep" ON "hosted_runners" ("state", "lastReconcileAt")`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "runner_enrollment_tokens" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "hostedRunnerId" uuid NOT NULL REFERENCES "hosted_runners"("id") ON DELETE CASCADE,
        "tokenHash" varchar(64) NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "usedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runner_enrollment_tokens_hash" ON "runner_enrollment_tokens" ("tokenHash")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_runner_enrollment_tokens_runner" ON "runner_enrollment_tokens" ("hostedRunnerId")`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "runner_usage_intervals" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "hostedRunnerId" uuid NOT NULL,
        "environmentId" uuid NOT NULL,
        "workspaceId" uuid NOT NULL,
        "agentId" uuid,
        "resourceClass" varchar(16) NOT NULL,
        "startedAt" timestamptz NOT NULL,
        "endedAt" timestamptz,
        "reportedAt" timestamptz,
        "meterIdentifier" varchar(128),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_runner_usage_intervals_order" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt")
      )
    `);
    // A billing record outlives the runner and environment it describes,
    // so no foreign keys there; at most one open interval per runner.
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runner_usage_intervals_open" ON "runner_usage_intervals" ("hostedRunnerId") WHERE "endedAt" IS NULL`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_runner_usage_intervals_org_started" ON "runner_usage_intervals" ("organizationId", "startedAt")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_runner_usage_intervals_runner" ON "runner_usage_intervals" ("hostedRunnerId")`);

    // ── runners: kind ──
    await q.query(`ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "kind" varchar(8) NOT NULL DEFAULT 'self'`);
    await q.query(`ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "hostedRunnerId" uuid`);
    await q.query(`ALTER TABLE "runners" DROP CONSTRAINT IF EXISTS "CHK_runners_kind"`);
    await q.query(`ALTER TABLE "runners" ADD CONSTRAINT "CHK_runners_kind" CHECK (
      ("kind" = 'self' AND "hostedRunnerId" IS NULL) OR ("kind" = 'hosted' AND "hostedRunnerId" IS NOT NULL)
    )`);
    // One self-hosted runner per account, as before; any number of hosted ones.
    await q.query(`DROP INDEX IF EXISTS "UQ_runners_owner_org"`);
    await q.query(`CREATE UNIQUE INDEX "UQ_runners_owner_org" ON "runners" ("ownerUserId", "organizationId") WHERE "kind" = 'self'`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runners_hosted_runner" ON "runners" ("hostedRunnerId") WHERE "hostedRunnerId" IS NOT NULL`);

    // ── workspaces: kind, environment, suspended ──
    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "kind" varchar(12) NOT NULL DEFAULT 'job'`);
    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "environmentId" uuid REFERENCES "environments"("id") ON DELETE SET NULL`);
    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "volumeRef" jsonb`);
    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "lastActiveAt" timestamptz`);
    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "expiryNoticeAt" timestamptz`);
    await q.query(`ALTER TABLE "workspaces" DROP CONSTRAINT IF EXISTS "CHK_workspaces_kind"`);
    await q.query(`ALTER TABLE "workspaces" ADD CONSTRAINT "CHK_workspaces_kind" CHECK ("kind" IN ('job', 'persistent'))`);
    // The status CHECK came from 1745310000000 as an unnamed column
    // constraint; replace whatever it was called with a named one that
    // knows `suspended`, which only a persistent workspace may be.
    await this.dropStatusChecks(q);
    await q.query(`ALTER TABLE "workspaces" ADD CONSTRAINT "CHK_workspaces_status" CHECK (
      "status" IN ('active', 'released', 'expired', 'stranded')
      OR ("status" = 'suspended' AND "kind" = 'persistent')
    )`);
    // At most one live persistent workspace per (environment, owner, agent);
    // an always-on agent's home is the row with its agentId.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_workspaces_persistent_live" ON "workspaces"
        ("environmentId", "ownerUserId", COALESCE("agentId", '00000000-0000-0000-0000-000000000000'::uuid))
        WHERE "kind" = 'persistent' AND "status" IN ('active', 'suspended')
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_workspaces_suspended_sweep" ON "workspaces" ("lastActiveAt") WHERE "status" = 'suspended'`);
  }

  /** Every CHECK on workspaces that mentions the status column, whatever Postgres named it. */
  private async dropStatusChecks(q: QueryRunner): Promise<void> {
    const rows: Array<{ conname: string }> = await q.query(`
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE t.relname = 'workspaces'
         AND n.nspname = current_schema()
         AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) LIKE '%status%'
    `);
    for (const row of rows) {
      await q.query(`ALTER TABLE "workspaces" DROP CONSTRAINT IF EXISTS "${row.conname.replace(/"/g, '""')}"`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_workspaces_suspended_sweep"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_workspaces_persistent_live"`);
    // Suspended and persistent rows have no meaning before this migration.
    await q.query(`UPDATE "workspaces" SET "status" = 'released', "closedAt" = COALESCE("closedAt", now()) WHERE "status" = 'suspended'`);
    await q.query(`DELETE FROM "workspaces" WHERE "kind" = 'persistent'`);
    await this.dropStatusChecks(q);
    await q.query(`ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_status_check" CHECK ("status" IN ('active', 'released', 'expired', 'stranded'))`);
    await q.query(`ALTER TABLE "workspaces" DROP CONSTRAINT IF EXISTS "CHK_workspaces_kind"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "expiryNoticeAt"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "lastActiveAt"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "volumeRef"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "environmentId"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "kind"`);

    await q.query(`DELETE FROM "runners" WHERE "kind" = 'hosted'`);
    await q.query(`DROP INDEX IF EXISTS "UQ_runners_hosted_runner"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_runners_owner_org"`);
    await q.query(`CREATE UNIQUE INDEX "UQ_runners_owner_org" ON "runners" ("ownerUserId", "organizationId")`);
    await q.query(`ALTER TABLE "runners" DROP CONSTRAINT IF EXISTS "CHK_runners_kind"`);
    await q.query(`ALTER TABLE "runners" DROP COLUMN IF EXISTS "hostedRunnerId"`);
    await q.query(`ALTER TABLE "runners" DROP COLUMN IF EXISTS "kind"`);

    await q.query(`DROP TABLE IF EXISTS "runner_usage_intervals"`);
    await q.query(`DROP TABLE IF EXISTS "runner_enrollment_tokens"`);
    await q.query(`DROP TABLE IF EXISTS "hosted_runners"`);
    await q.query(`DROP TABLE IF EXISTS "environments"`);
  }
}
