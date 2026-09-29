import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { moveAppsToChannels } from './support/channels-on-the-agent';

/**
 * Channels on the agent.
 *
 * Apps and their places are gone: an agent has channels (web chat, website
 * widget, messaging platforms, A2A, desktop and terminal apps), and its
 * branding and visitor rules live on the agent, overridable per channel.
 * This moves what the apps held onto the agents they answered with.
 *
 * - Each place becomes a channel with the SAME id (so the credential it
 *   manages, its builds and its gateway keep pointing at it), on the agent
 *   it answers with: the place's `configuration.agentId`, else the app's
 *   first agent. A place whose agent no longer exists in the organization
 *   is not moved and is logged; its rows stay where they are.
 * - The app's branding (its name when branding has none) and visitor rules
 *   (sign-in, limits, privacy) are copied onto each agent that receives
 *   one of its places, or onto its first agent when it has none. When two
 *   apps put different settings on the same agent, the first app (oldest)
 *   wins on the agent and the later app's settings go onto ITS channels as
 *   overrides, so what visitors of those channels see does not change. Each
 *   such conflict is logged.
 * - Downloads keep what they may touch (`capabilities`), and a desktop app
 *   keeps opening the web chat of the app it came from.
 * - A web chat keeps its address (the gateway's hostedChat slug).
 * - A published place's gateway gets `configuration.channelId` instead of
 *   `appId`; its endpoint is untouched, because platforms were given it.
 * - Managed credentials of places are re-labelled as the channel's.
 * - Builds point at their channel; runs gain a channelId for spend caps.
 *
 * The app tables themselves are left in place, untouched and unread, so
 * nothing is lost if a mapping above needs a second look.
 */
export class ChannelsOnTheAgent1750813742000 implements MigrationInterface {
  name = 'ChannelsOnTheAgent1750813742000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const logger = new Logger(this.name);

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
        ALTER COLUMN "appId" DROP NOT NULL,
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

    await moveAppsToChannels(queryRunner, logger);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "credentials" c
         SET "metadata" = jsonb_set(c."metadata"::jsonb, '{managedBy,kind}', '"app_distribution"')::json
        FROM "agent_channels" ch
       WHERE c."metadata"::jsonb -> 'managedBy' ->> 'kind' = 'agent_channel'
         AND c."metadata"::jsonb -> 'managedBy' ->> 'id' = ch.id::text
         AND EXISTS (SELECT 1 FROM "agent_app_distributions" d WHERE d.id = ch.id)
    `);
    await queryRunner.query(`
      UPDATE "gateways" g
         SET "configuration" = ((g."configuration"::jsonb - 'channelId') || jsonb_build_object('appId', d."appId"::text))::json
        FROM "agent_app_distributions" d
       WHERE d."gatewayId" = g.id
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_agent_runs_channelId_updatedAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "channelId"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_app_builds_channelId_createdAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "app_builds" DROP CONSTRAINT IF EXISTS "FK_app_builds_channel"
    `);
    await queryRunner.query(`
      ALTER TABLE "app_builds" DROP COLUMN IF EXISTS "channelId", DROP COLUMN IF EXISTS "agentId"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "agent_channels"
    `);
    await queryRunner.query(`
      ALTER TABLE "agents" DROP COLUMN IF EXISTS "branding", DROP COLUMN IF EXISTS "visitorRules"
    `);
  }
}
