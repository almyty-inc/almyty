import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Always on (docs/always-on.md): the Heartbeat setting on autonomous agents
 * becomes Always on, and wakes get an inbox.
 *
 * - `agents.heartbeat` is renamed `agents.alwaysOn` and reshaped:
 *   `enabled`, the interval (now `wakeOn.timer.everyMinutes`), the prompt
 *   (now `brief`) and `pausedReason` carry over. An agent that already
 *   had a heartbeat keeps running every tool on its own (`actMode: 'act'`,
 *   nothing on its ask-first list), as it did; a new one starts at
 *   `propose`.
 * - `agent_wakes` is the inbox between events and runs: one row per wake,
 *   unique per agent and dedupe key.
 */
export class AlwaysOn1750813802000 implements MigrationInterface {
  name = 'AlwaysOn1750813802000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" RENAME COLUMN "heartbeat" TO "alwaysOn"`);
    const rows: Array<{ id: string; alwaysOn: any }> = await queryRunner.query(
      `SELECT "id", "alwaysOn" FROM "agents" WHERE "alwaysOn" IS NOT NULL`,
    );
    for (const row of rows) {
      const old = typeof row.alwaysOn === 'string' ? safeParse(row.alwaysOn) : row.alwaysOn;
      if (!old || typeof old !== 'object') {
        await queryRunner.query(`UPDATE "agents" SET "alwaysOn" = NULL WHERE "id" = $1`, [row.id]);
        continue;
      }
      if (old.wakeOn) continue; // already in the new shape
      const minutes = Number(old.intervalMinutes);
      const reshaped = {
        enabled: old.enabled === true,
        brief: typeof old.prompt === 'string' ? old.prompt : '',
        wakeOn: { timer: { everyMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 60 } },
        actMode: 'act',
        askFirstToolIds: [],
        reportTo: null,
        report: 'when_acted',
        ...(old.pausedReason ? { pausedReason: old.pausedReason } : {}),
      };
      await queryRunner.query(`UPDATE "agents" SET "alwaysOn" = $2::json WHERE "id" = $1`, [row.id, JSON.stringify(reshaped)]);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_wakes" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "agentId" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
        "source" varchar(16) NOT NULL,
        "sourceRef" varchar(255),
        "summary" varchar(500) NOT NULL,
        "payload" jsonb,
        "dedupeKey" varchar(255) NOT NULL,
        "status" varchar(12) NOT NULL DEFAULT 'queued',
        "runId" uuid,
        "note" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "consumedAt" timestamptz,
        CONSTRAINT "CHK_agent_wakes_source" CHECK ("source" IN ('timer', 'channel', 'webhook', 'connection', 'manual')),
        CONSTRAINT "CHK_agent_wakes_status" CHECK ("status" IN ('queued', 'consumed', 'coalesced', 'dropped'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_agent_wakes_agent_dedupe" ON "agent_wakes" ("agentId", "dedupeKey")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_wakes_agent_status" ON "agent_wakes" ("agentId", "status", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_wakes"`);
    const rows: Array<{ id: string; alwaysOn: any }> = await queryRunner.query(
      `SELECT "id", "alwaysOn" FROM "agents" WHERE "alwaysOn" IS NOT NULL`,
    );
    for (const row of rows) {
      const now = typeof row.alwaysOn === 'string' ? safeParse(row.alwaysOn) : row.alwaysOn;
      if (!now || typeof now !== 'object' || !now.wakeOn) continue;
      const heartbeat = {
        enabled: now.enabled === true,
        intervalMinutes: Number(now.wakeOn?.timer?.everyMinutes) || 60,
        prompt: typeof now.brief === 'string' ? now.brief : '',
        ...(now.pausedReason ? { pausedReason: now.pausedReason } : {}),
      };
      await queryRunner.query(`UPDATE "agents" SET "alwaysOn" = $2::json WHERE "id" = $1`, [row.id, JSON.stringify(heartbeat)]);
    }
    await queryRunner.query(`ALTER TABLE "agents" RENAME COLUMN "alwaysOn" TO "heartbeat"`);
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
