import { MigrationInterface, QueryRunner } from 'typeorm';

import { AppAuthMode } from '../entities/agent-app.entity';
import { DistributionTarget } from '../entities/agent-app-distribution.entity';
import { APP_SURFACE_GATEWAY_TYPES } from '../modules/gateways/app-surface';
import { appSlugError } from '../modules/agent-apps/agent-app.rules';
import {
  appSlugFromName,
  newAppFields,
  placeConfigurationFrom,
  targetForGatewayType,
} from '../modules/agent-apps/new-app';

/**
 * Every web chat and messaging channel belongs to an app.
 *
 * An app is the one place an agent is put in front of people, and the
 * gateways it stands up are recorded on its places (`gatewayId`). A web
 * chat or a Slack, Discord, Teams, ... gateway that no place points at is
 * wrapped in one here:
 *
 * - One app per agent (per organization), named after the agent, with the
 *   agent as its default. Gateways of the same agent on different
 *   platforms become places of the same app; a second gateway of the
 *   same agent on the same platform gets an app of its own, since an app
 *   ships to a platform once.
 * - The app row is the one `AgentAppsService.create` saves
 *   (`newAppFields`: default limits, empty branding, public link unless a
 *   web chat carried its own sign-in rule). Its slug comes from the name
 *   (`appSlugFromName`), made free against the organization's apps; a
 *   web chat's app keeps the chat's address when it is free, because the
 *   web place is addressed by its app's slug.
 * - The place points at the gateway, is live when the gateway is active,
 *   and carries the gateway's connection reference and non-secret
 *   platform settings (`placeConfigurationFrom`), so republishing from the
 *   app finds everything the gateway answers with.
 * - The gateway's configuration records the app (`appId`), as a publish
 *   writes it.
 *
 * A private agent is not put on an app (an app refuses one); its gateway
 * still gets an app, named after it, with no agent to publish until one
 * is shared. `down()` leaves the apps in place.
 */
export class EveryChatSurfaceHasAnApp1750812800000 implements MigrationInterface {
  name = 'EveryChatSurfaceHasAnApp1750812800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orphans: Array<{
      id: string;
      organizationId: string;
      type: string;
      name: string;
      description: string | null;
      status: string;
      agentId: string | null;
      configuration: Record<string, any> | null;
      agentName: string | null;
      agentVisibility: string | null;
    }> = await queryRunner.query(
      `SELECT g.id, g."organizationId", g."type", g.name, g.description, g.status, g."agentId",
              g.configuration::jsonb AS configuration,
              a.name AS "agentName", a.visibility AS "agentVisibility"
         FROM "gateways" g
         LEFT JOIN "agents" a ON a.id = g."agentId" AND a."organizationId" = g."organizationId"
        WHERE g."type" = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM "agent_app_distributions" d WHERE d."gatewayId" = g.id)
        ORDER BY (g."type" = 'hosted_chat') DESC, g."createdAt", g.id`,
      [[...APP_SURFACE_GATEWAY_TYPES]],
    );
    if (orphans.length === 0) return;

    const slugsByOrg = new Map<string, Set<string>>();
    const slugsOf = async (organizationId: string) => {
      let slugs = slugsByOrg.get(organizationId);
      if (!slugs) {
        const rows: Array<{ slug: string }> = await queryRunner.query(
          `SELECT slug FROM "agent_apps" WHERE "organizationId" = $1`,
          [organizationId],
        );
        slugs = new Set(rows.map((r) => r.slug));
        slugsByOrg.set(organizationId, slugs);
      }
      return slugs;
    };

    // Apps made by this run, per organization and agent, with the targets they already ship to.
    // Web chats go first, so an agent's app takes its web address as its slug.
    const made = new Map<string, Array<{ id: string; targets: Set<string> }>>();

    for (const gateway of orphans) {
      const target = targetForGatewayType(gateway.type);
      if (!target) continue;
      const configuration = gateway.configuration ?? {};
      const key = `${gateway.organizationId}:${gateway.agentId ?? gateway.id}`;
      const siblings = made.get(key) ?? [];
      let app = siblings.find((candidate) => !candidate.targets.has(target));

      if (!app) {
        const slugs = await slugsOf(gateway.organizationId);
        const name = gateway.agentName || gateway.name;
        const signIn = target === DistributionTarget.WEB ? configuration.hostedChat?.authMode : undefined;
        const authMode = Object.values(AppAuthMode).includes(signIn) ? (signIn as AppAuthMode) : AppAuthMode.PUBLIC_LINK;
        const webAddress = target === DistributionTarget.WEB ? String(configuration.hostedChat?.slug ?? '').toLowerCase() : '';
        const fields = newAppFields(gateway.organizationId, {
          name,
          // A web chat is addressed by its app's slug, so its app keeps the
          // address the chat already answers on when that is free.
          slug: webAddress && !appSlugError(webAddress) && !slugs.has(webAddress)
            ? webAddress
            : appSlugFromName(name, (slug) => slugs.has(slug)),
          description: gateway.description ?? undefined,
          agentIds: gateway.agentId && gateway.agentName && gateway.agentVisibility !== 'private' ? [gateway.agentId] : [],
          authMode,
        });
        const [row]: Array<{ id: string }> = await queryRunner.query(
          `INSERT INTO "agent_apps"
             ("id", "organizationId", "name", "slug", "description", "agentIds", "branding", "authMode", "capabilities", "limits", "privacy", "isActive")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::uuid[], $6::json, $7, $8::json, $9::json, $10::json, $11)
           RETURNING "id"`,
          [
            fields.organizationId,
            fields.name,
            fields.slug,
            fields.description,
            fields.agentIds,
            JSON.stringify(fields.branding),
            fields.authMode,
            JSON.stringify(fields.capabilities),
            JSON.stringify(fields.limits),
            fields.privacy === null ? null : JSON.stringify(fields.privacy),
            fields.isActive,
          ],
        );
        slugs.add(fields.slug);
        app = { id: row.id, targets: new Set() };
        siblings.push(app);
        made.set(key, siblings);
      }

      await queryRunner.query(
        `INSERT INTO "agent_app_distributions" ("id", "organizationId", "appId", "target", "status", "gatewayId", "configuration")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::json)`,
        [
          gateway.organizationId,
          app.id,
          target,
          gateway.status === 'active' ? 'live' : 'draft',
          gateway.id,
          JSON.stringify(placeConfigurationFrom(target, configuration)),
        ],
      );
      app.targets.add(target);

      await queryRunner.query(
        `UPDATE "gateways"
            SET "configuration" = (COALESCE("configuration"::jsonb, '{}'::jsonb) || jsonb_build_object('appId', $2::text))::json
          WHERE id = $1`,
        [gateway.id, app.id],
      );
    }
  }

  public async down(): Promise<void> {
    // The apps stay: they are ordinary apps now, and removing them would
    // leave their surfaces owned by nothing again.
  }
}
