import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { moveAppsToChannels } from './support/channels-on-the-agent';

/**
 * Channels on the agent.
 *
 * An agent has channels (web chat, website widget, messaging platforms,
 * A2A, desktop and terminal apps), and its branding and visitor rules live
 * on the agent, overridable per channel. This creates them from what the
 * apps held, then drops the app tables.
 *
 * - Each place becomes a channel with the same id, on the agent it answers
 *   with: the place's `configuration.agentId`, else the app's first agent.
 *   A place whose agent no longer exists in the organization is logged and
 *   dropped with the app tables. A standalone binary becomes a terminal
 *   app, which compiles to the same file.
 * - The app's branding (its name when branding has none) and visitor rules
 *   (sign-in, limits, privacy) are copied onto each agent that receives
 *   one of its places, or onto its first agent when it has none. When two
 *   apps put different settings on the same agent, the first app (oldest)
 *   wins on the agent and the later app's settings go onto its channels as
 *   overrides, so what visitors of those channels see does not change. Each
 *   such conflict is logged.
 * - Each channel is named after its kind, with the app's name added when
 *   the agent already has a channel of that name.
 * - Downloads keep what they may touch (`capabilities`), and a desktop app
 *   opens the web chat of the app it came from.
 * - A web chat keeps its address (the gateway's hostedChat slug).
 * - A published place's gateway answers at `/channels/<channel id>` and
 *   names its channel in `configuration.channelId`.
 * - The credential a place kept its keys in becomes an ordinary credential
 *   on Credentials, named after the agent and the channel.
 * - Builds point at their channel. A build whose place was not moved goes.
 */
export class ChannelsOnTheAgent1750813742000 implements MigrationInterface {
  name = 'ChannelsOnTheAgent1750813742000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const logger = new Logger(this.name);
    await this.createChannelSchema(queryRunner);
    await moveAppsToChannels(queryRunner, logger);
    await this.dropAppModel(queryRunner);
  }

  /** The agent's branding and visitor rules, its channels, and what builds and runs point at. */
  async createChannelSchema(queryRunner: Pick<QueryRunner, 'query'>): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agents"
        ADD COLUMN IF NOT EXISTS "branding" json,
        ADD COLUMN IF NOT EXISTS "visitorRules" json
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_channels" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "agentId" uuid NOT NULL,
        "type" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'draft',
        "name" character varying(120) NOT NULL,
        "slug" character varying,
        "gatewayId" uuid,
        "configuration" json,
        "branding" json,
        "visitorRules" json,
        "lastBuild" json,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_channels" PRIMARY KEY ("id"),
        CONSTRAINT "FK_agent_channels_organization" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_agent_channels_agent" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_agent_channels_gateway" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_channels_org_agent" ON "agent_channels" ("organizationId", "agentId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_channels_gatewayId" ON "agent_channels" ("gatewayId")
    `);

    await queryRunner.query(`
      ALTER TABLE "app_builds"
        ADD COLUMN IF NOT EXISTS "channelId" uuid,
        ADD COLUMN IF NOT EXISTS "agentId" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "app_builds" DROP CONSTRAINT IF EXISTS "FK_app_builds_channel"
    `);
    await queryRunner.query(`
      ALTER TABLE "app_builds" ADD CONSTRAINT "FK_app_builds_channel"
        FOREIGN KEY ("channelId") REFERENCES "agent_channels"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_app_builds_channelId_createdAt" ON "app_builds" ("channelId", "createdAt")
    `);

    await queryRunner.query(`
      ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "channelId" uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_runs_channelId_updatedAt" ON "agent_runs" ("channelId", "updatedAt") WHERE "channelId" IS NOT NULL
    `);
  }

  /** What the apps held is on the agents and channels now: drop the app tables and what pointed at them. */
  async dropAppModel(queryRunner: Pick<QueryRunner, 'query'>): Promise<void> {
    await queryRunner.query(`DELETE FROM "app_builds" WHERE "channelId" IS NULL`);
    await queryRunner.query(`ALTER TABLE "app_builds" DROP CONSTRAINT IF EXISTS "FK_app_builds_app"`);
    await queryRunner.query(`ALTER TABLE "app_builds" DROP COLUMN IF EXISTS "appId"`);
    await queryRunner.query(`
      ALTER TABLE "app_builds"
        ALTER COLUMN "channelId" SET NOT NULL,
        ALTER COLUMN "agentId" SET NOT NULL
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_runs_appId_updatedAt"`);
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "appId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_app_distributions" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_apps" CASCADE`);
  }

  /**
   * The app tables are dropped and their rows are channels now; there is
   * nothing to put back. Restore a backup taken before this migration.
   */
  public async down(): Promise<void> {
    throw new Error('ChannelsOnTheAgent1750813742000 drops the app tables and cannot be reverted. Restore a backup taken before it.');
  }
}
