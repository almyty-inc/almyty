import type { QueryRunner } from 'typeorm';

import { AgentApp, AppAuthMode } from '../../entities/agent-app.entity';
import { DistributionTarget } from '../../entities/agent-app-distribution.entity';
import { appSlugError } from './agent-app.rules';
import { appSlugFromName, newAppFields, placeConfigurationFrom, targetForGatewayType } from './new-app';

/** A gateway of a place type that no place points at yet. */
export interface UnownedPlaceGateway {
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
}

export interface WrapUnownedPlacesOptions {
  /**
   * Put the gateway on an app the organization already has, answering
   * with the same agent (its default), when that app does not ship to the
   * platform yet. Without it every run makes its own apps.
   */
  joinAgentApps?: boolean;
  /** The look of an app this run makes, read off the gateway it is made for. */
  brandingFor?: (gateway: UnownedPlaceGateway) => AgentApp['branding'] | undefined;
}

/**
 * Wrap every gateway of `types` that no app place points at in a place on
 * an app. Used by the migrations that make a gateway type an app's place,
 * so each one builds the app, the place and the link the same way:
 *
 * - One app per agent (per organization), named after the agent, with the
 *   agent as its default. Gateways of the same agent on different
 *   platforms become places of the same app; a second gateway of the same
 *   agent on the same platform gets an app of its own, since an app ships
 *   to a platform once.
 * - The app row is the one `AgentAppsService.create` saves (`newAppFields`),
 *   its slug made free against the organization's apps. A web chat's app
 *   keeps the chat's address when it is free.
 * - The place points at the gateway, is live when the gateway is active,
 *   and carries the connection reference and non-secret platform settings.
 * - The gateway's configuration records the app (`appId`).
 *
 * A private agent is not put on an app; its gateway still gets one, named
 * after it, with no agent until one is shared. Raw SQL throughout, so it
 * runs against the schema as the migration finds it. A second run finds
 * nothing to do.
 */
export async function wrapUnownedPlaces(
  queryRunner: Pick<QueryRunner, 'query'>,
  types: readonly string[],
  options: WrapUnownedPlacesOptions = {},
): Promise<void> {
  const orphans: UnownedPlaceGateway[] = await queryRunner.query(
    `SELECT g.id, g."organizationId", g."type", g.name, g.description, g.status, g."agentId",
            g.configuration::jsonb AS configuration,
            a.name AS "agentName", a.visibility AS "agentVisibility"
       FROM "gateways" g
       LEFT JOIN "agents" a ON a.id = g."agentId" AND a."organizationId" = g."organizationId"
      WHERE g."type" = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM "agent_app_distributions" d WHERE d."gatewayId" = g.id)
      ORDER BY (g."type" = 'hosted_chat') DESC, g."createdAt", g.id`,
    [[...types]],
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

  // Apps per organization and agent, with the targets they already ship
  // to: the ones this run made, and with joinAgentApps the ones the
  // organization had. Web chats go first, so an agent's new app takes its
  // web address as its slug.
  const apps = new Map<string, Array<{ id: string; targets: Set<string> }>>();
  const appsOf = async (gateway: UnownedPlaceGateway) => {
    const key = `${gateway.organizationId}:${gateway.agentId ?? gateway.id}`;
    let list = apps.get(key);
    if (!list) {
      list = [];
      if (options.joinAgentApps && gateway.agentId) {
        const rows: Array<{ id: string; targets: string[] | null }> = await queryRunner.query(
          `SELECT a.id, array_remove(array_agg(d.target), NULL) AS targets
             FROM "agent_apps" a
             LEFT JOIN "agent_app_distributions" d ON d."appId" = a.id
            WHERE a."organizationId" = $1 AND a."agentIds"[1] = $2
            GROUP BY a.id, a."createdAt"
            ORDER BY a."createdAt", a.id`,
          [gateway.organizationId, gateway.agentId],
        );
        for (const row of rows) list.push({ id: row.id, targets: new Set(row.targets ?? []) });
      }
      apps.set(key, list);
    }
    return list;
  };

  for (const gateway of orphans) {
    const target = targetForGatewayType(gateway.type);
    if (!target) continue;
    const configuration = gateway.configuration ?? {};
    const siblings = await appsOf(gateway);
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
        branding: options.brandingFor?.(gateway),
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

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const THEMES = ['dark', 'light', 'auto'];

/**
 * A chat widget's saved look (`configuration.widget`) as app branding,
 * keeping only valid fields. An app-owned widget reads its look from the
 * app, so an app made for a widget starts with the look it had.
 */
export function widgetBranding(gateway: Pick<UnownedPlaceGateway, 'type' | 'configuration'>): AgentApp['branding'] | undefined {
  if (gateway.type !== 'chat_widget') return undefined;
  const widget = gateway.configuration?.widget;
  if (!widget || typeof widget !== 'object' || Array.isArray(widget)) return undefined;
  const branding: AgentApp['branding'] = {};
  if (typeof widget.title === 'string' && widget.title.trim()) branding.appName = widget.title.trim().slice(0, 60);
  if (typeof widget.primaryColor === 'string' && HEX_COLOR.test(widget.primaryColor.trim())) {
    branding.primaryColor = widget.primaryColor.trim().toLowerCase();
  }
  if (typeof widget.greeting === 'string' && widget.greeting.trim()) branding.greeting = widget.greeting.trim().slice(0, 300);
  if (THEMES.includes(widget.theme)) branding.theme = widget.theme;
  return Object.keys(branding).length ? branding : undefined;
}
