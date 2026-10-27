import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Push wakes (docs/always-on.md, "When a service tells it something
 * changed"):
 *
 * - `push_subscriptions`: one subscription at a service that pushes
 *   changes. The spec (verification, subscribe/renew/stop, what changed) is
 *   data; the verification value is a managed credential referenced by
 *   `verifyCredentialId`. Agents subscribing the same connection to the
 *   same resource share one row (`subscriptionKey`, unique per org), since
 *   a service may allow one subscription per resource (one watch per mailbox).
 * - `agent_push_wakes`: an agent's membership in a subscription. Rows go
 *   with their agent and with their subscription.
 * - `agent_wakes.source` takes `push`.
 */
export class AgentPushWakes1791000600000 implements MigrationInterface {
  name = 'AgentPushWakes1791000600000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "push_subscriptions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "apiId" uuid REFERENCES "apis"("id") ON DELETE SET NULL,
        "presetKey" varchar(64),
        "subscriptionKey" varchar(64) NOT NULL,
        "name" varchar(120) NOT NULL,
        "spec" jsonb NOT NULL,
        "settings" jsonb NOT NULL DEFAULT '{}',
        "verifyCredentialId" uuid REFERENCES "credentials"("id") ON DELETE SET NULL,
        "state" jsonb NOT NULL DEFAULT '{}',
        "debounceSeconds" int NOT NULL DEFAULT 10,
        "health" varchar(16) NOT NULL DEFAULT 'unknown',
        "lastError" varchar(500),
        "lastErrorAt" timestamptz,
        "lastPushAt" timestamptz,
        "pushCount" int NOT NULL DEFAULT 0,
        "lastRenewedAt" timestamptz,
        "subscriptionExpiresAt" timestamptz,
        "renewAt" timestamptz,
        "createdBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_push_subscriptions_health" CHECK ("health" IN ('valid', 'failed', 'expired', 'unknown')),
        CONSTRAINT "CHK_push_subscriptions_debounce" CHECK ("debounceSeconds" BETWEEN 0 AND 3600)
      )
    `);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_push_subscriptions_key" ON "push_subscriptions" ("organizationId", "subscriptionKey")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_push_subscriptions_renew" ON "push_subscriptions" ("renewAt")`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "agent_push_wakes" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "agentId" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
        "subscriptionId" uuid NOT NULL REFERENCES "push_subscriptions"("id") ON DELETE CASCADE,
        "lastWakeAt" timestamptz,
        "createdBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_agent_push_wakes_agent" ON "agent_push_wakes" ("agentId")`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_agent_push_wakes_agent_subscription" ON "agent_push_wakes" ("agentId", "subscriptionId")`);

    await q.query(`ALTER TABLE "agent_wakes" DROP CONSTRAINT IF EXISTS "CHK_agent_wakes_source"`);
    await q.query(
      `ALTER TABLE "agent_wakes" ADD CONSTRAINT "CHK_agent_wakes_source" CHECK ("source" IN ('timer', 'channel', 'webhook', 'connection', 'manual', 'push'))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "agent_wakes" WHERE "source" = 'push'`);
    await q.query(`ALTER TABLE "agent_wakes" DROP CONSTRAINT IF EXISTS "CHK_agent_wakes_source"`);
    await q.query(
      `ALTER TABLE "agent_wakes" ADD CONSTRAINT "CHK_agent_wakes_source" CHECK ("source" IN ('timer', 'channel', 'webhook', 'connection', 'manual'))`,
    );
    await q.query(`DROP TABLE IF EXISTS "agent_push_wakes"`);
    await q.query(`DROP TABLE IF EXISTS "push_subscriptions"`);
  }
}
