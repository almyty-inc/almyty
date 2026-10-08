import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hosted pods' model access and inherited workspaces (Frane, 2026-10-08;
 * docs/hosted-runners.md):
 *
 * - `hosted_model_calls`: one row per call a pod's coding CLI made through
 *   the model pass-through, with its tokens and cost. A spend source next
 *   to agent_runs and agent_executions, so organization budgets see it.
 *   `agentId` is always null (no agent ran); it is there so the spend
 *   queries read the three tables alike.
 * - `workspaces.readOnly` / `inheritedFromUserId`: a departed member's
 *   workspace handed to an admin who already has one on that environment
 *   is kept beside it, read-only. Such a workspace is outside the
 *   one-live-workspace index, so the admin keeps both.
 */
export class HostedPodModelAccess1791000400000 implements MigrationInterface {
  name = 'HostedPodModelAccess1791000400000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "hosted_model_calls" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "agentId" uuid,
        "userId" uuid,
        "hostedRunnerId" uuid NOT NULL,
        "environmentId" uuid NOT NULL,
        "workspaceId" uuid NOT NULL,
        "providerId" uuid,
        "modelId" uuid,
        "vendorModelId" varchar(255) NOT NULL,
        "protocol" varchar(32) NOT NULL,
        "status" int NOT NULL,
        "stream" boolean NOT NULL DEFAULT false,
        "inputTokens" int NOT NULL DEFAULT 0,
        "outputTokens" int NOT NULL DEFAULT 0,
        "totalCost" double precision NOT NULL DEFAULT 0,
        "durationMs" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_hosted_model_calls_agent" CHECK ("agentId" IS NULL)
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_hosted_model_calls_org_created" ON "hosted_model_calls" ("organizationId", "createdAt")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_hosted_model_calls_runner" ON "hosted_model_calls" ("hostedRunnerId")`);

    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "readOnly" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "inheritedFromUserId" uuid`);
    await q.query(`DROP INDEX IF EXISTS "UQ_workspaces_persistent_live"`);
    await q.query(`
      CREATE UNIQUE INDEX "UQ_workspaces_persistent_live" ON "workspaces"
        ("environmentId", "ownerUserId", COALESCE("agentId", '00000000-0000-0000-0000-000000000000'::uuid))
        WHERE "kind" = 'persistent' AND "status" IN ('active', 'suspended') AND "readOnly" = false
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // An inherited read-only workspace has no place in the narrower index.
    await q.query(`UPDATE "workspaces" SET "status" = 'released', "closedAt" = COALESCE("closedAt", now()) WHERE "readOnly" = true AND "status" IN ('active', 'suspended')`);
    await q.query(`DROP INDEX IF EXISTS "UQ_workspaces_persistent_live"`);
    await q.query(`
      CREATE UNIQUE INDEX "UQ_workspaces_persistent_live" ON "workspaces"
        ("environmentId", "ownerUserId", COALESCE("agentId", '00000000-0000-0000-0000-000000000000'::uuid))
        WHERE "kind" = 'persistent' AND "status" IN ('active', 'suspended')
    `);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "inheritedFromUserId"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "readOnly"`);
    await q.query(`DROP TABLE IF EXISTS "hosted_model_calls"`);
  }
}
