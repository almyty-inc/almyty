import type { Logger } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';

/**
 * The data move of 1750813742000-ChannelsOnTheAgent: every app place
 * becomes a channel on the agent it answers with, and each app's branding
 * and visitor rules go onto those agents. Kept out of the migration file
 * because TypeORM treats every export of a migration file as a migration;
 * exported here so the integration spec runs exactly this.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESSED = ['web', 'desktop', 'tui', 'binary'];
const DOWNLOADS = ['desktop', 'tui', 'binary'];

interface AppRow {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  agentIds: string[] | null;
  branding: Record<string, any> | null;
  authMode: string | null;
  capabilities: Record<string, any> | null;
  limits: Record<string, any> | null;
  privacy: Record<string, any> | null;
}

interface PlaceRow {
  id: string;
  organizationId: string;
  appId: string;
  target: string;
  status: string;
  gatewayId: string | null;
  configuration: Record<string, any> | null;
  lastBuild: Record<string, any> | null;
  createdAt: Date;
  updatedAt: Date;
  hostedChatSlug: string | null;
}

/** What one app puts on an agent. Stable key order, so two apps compare by value. */
export function appSettingsFor(app: Pick<AppRow, 'name' | 'branding' | 'authMode' | 'limits' | 'privacy'>) {
  const branding = { ...(app.branding ?? {}) };
  if (!String(branding.appName ?? '').trim()) branding.appName = app.name;
  return {
    branding,
    visitorRules: {
      authMode: app.authMode ?? 'public_link',
      limits: app.limits ?? null,
      privacy: app.privacy ?? null,
    },
  };
}

function sameSettings(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as any)[k])]))
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * The move itself, exported so the integration spec runs exactly this.
 * Idempotent: a channel already there (same id) is left alone, and an
 * agent that already has settings is only ever given more by conflict
 * overrides on the new channels.
 */
export async function moveAppsToChannels(queryRunner: Pick<QueryRunner, 'query'>, logger?: Pick<Logger, 'log' | 'warn'>) {
  const exists = await queryRunner.query(`SELECT to_regclass('agent_apps') IS NOT NULL AS "apps", to_regclass('agent_app_distributions') IS NOT NULL AS "places"`);
  if (!exists?.[0]?.apps || !exists?.[0]?.places) return { moved: 0, skipped: [], conflicts: [] };

  const apps: AppRow[] = await queryRunner.query(
    `SELECT id, "organizationId", name, slug, "agentIds", branding::jsonb AS branding, "authMode",
            capabilities::jsonb AS capabilities, limits::jsonb AS limits, privacy::jsonb AS privacy
       FROM "agent_apps" ORDER BY "createdAt", id`,
  );
  const places: PlaceRow[] = await queryRunner.query(
    `SELECT d.id, d."organizationId", d."appId", d.target, d.status, d."gatewayId",
            d.configuration::jsonb AS configuration, d."lastBuild"::jsonb AS "lastBuild", d."createdAt", d."updatedAt",
            g.configuration::jsonb -> 'hostedChat' ->> 'slug' AS "hostedChatSlug"
       FROM "agent_app_distributions" d
       LEFT JOIN "gateways" g ON g.id = d."gatewayId"
      ORDER BY d."createdAt", d.id`,
  );
  const agents: Array<{ id: string; organizationId: string; branding: unknown; visitorRules: unknown }> = await queryRunner.query(
    `SELECT id, "organizationId", branding::jsonb AS branding, "visitorRules"::jsonb AS "visitorRules" FROM "agents"`,
  );
  const agentOrg = new Map(agents.map((a) => [a.id, String(a.organizationId)]));
  // Agents that already carry settings (set by hand, or by an earlier run
  // of this) keep them; an app that agrees with them is not a conflict.
  const settled = new Map<string, { appId: string; settings: ReturnType<typeof appSettingsFor> }>();
  for (const a of agents) {
    if (a.branding != null || a.visitorRules != null) {
      settled.set(a.id, { appId: 'agent', settings: { branding: a.branding, visitorRules: a.visitorRules } as any });
    }
  }

  const skipped: Array<{ placeId: string; appId: string; target: string }> = [];
  const conflicts: Array<{ agentId: string; keptAppId: string; conflictingAppId: string }> = [];
  let moved = 0;

  for (const app of apps) {
    const org = String(app.organizationId);
    const inOrg = (id: unknown): string | null =>
      typeof id === 'string' && UUID.test(id.trim()) && agentOrg.get(id.trim()) === org ? id.trim() : null;
    const defaultAgent = inOrg(app.agentIds?.[0]);
    const appPlaces = places.filter((p) => p.appId === app.id);
    const settings = appSettingsFor(app);

    const resolved = appPlaces.map((place) => ({
      place,
      agentId: typeof place.configuration?.agentId === 'string' && place.configuration.agentId.trim()
        ? inOrg(place.configuration.agentId)
        : defaultAgent,
    }));
    const receiving = [...new Set(resolved.map((r) => r.agentId).filter((id): id is string => !!id))];
    if (appPlaces.length === 0 && defaultAgent) receiving.push(defaultAgent);

    // Whose settings each receiving agent ends up with, and where this
    // app's own have to go as channel overrides instead.
    const overridden = new Set<string>();
    for (const agentId of receiving) {
      const kept = settled.get(agentId);
      if (!kept) {
        await queryRunner.query(
          `UPDATE "agents" SET "branding" = $2::json, "visitorRules" = $3::json WHERE id = $1`,
          [agentId, JSON.stringify(settings.branding), JSON.stringify(settings.visitorRules)],
        );
        settled.set(agentId, { appId: app.id, settings });
      } else if (kept && sameSettings(kept.settings, settings)) {
        continue;
      } else {
        overridden.add(agentId);
        conflicts.push({ agentId, keptAppId: kept.appId, conflictingAppId: app.id });
        logger?.warn(
          `Agent ${agentId} keeps the branding and visitor rules of ${kept.appId === 'agent' ? 'its own settings' : `app ${kept.appId}`}; ` +
            `app ${app.id} (${app.slug}) differs, so its channels carry its settings as overrides.`,
        );
      }
    }

    const webPlace = resolved.find((r) => r.place.target === 'web' && r.agentId);
    for (const { place, agentId } of resolved) {
      if (!agentId) {
        skipped.push({ placeId: place.id, appId: app.id, target: place.target });
        logger?.warn(`Place ${place.id} (${place.target}) of app ${app.id} (${app.slug}) has no agent in its organization and was not moved.`);
        continue;
      }
      const { agentId: _named, ...configuration } = place.configuration ?? {};
      if (DOWNLOADS.includes(place.target) && app.capabilities && Object.keys(app.capabilities).length > 0) {
        configuration.capabilities = app.capabilities;
      }
      if (place.target === 'desktop' && webPlace && !configuration.webChatChannelId) {
        configuration.webChatChannelId = webPlace.place.id;
      }
      const slug = ADDRESSED.includes(place.target)
        ? (place.target === 'web' && place.hostedChatSlug) || app.slug
        : null;
      const override = overridden.has(agentId);
      const inserted = await queryRunner.query(
        `INSERT INTO "agent_channels"
           ("id", "organizationId", "agentId", "type", "status", "slug", "gatewayId", "configuration",
            "branding", "visitorRules", "lastBuild", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9::json, $10::json, $11::json, $12, $13)
         ON CONFLICT ("id") DO NOTHING
         RETURNING id`,
        [
          place.id,
          place.organizationId,
          agentId,
          place.target,
          place.status,
          slug,
          place.gatewayId,
          JSON.stringify(configuration),
          override ? JSON.stringify(settings.branding) : null,
          override ? JSON.stringify(settings.visitorRules) : null,
          place.lastBuild == null ? null : JSON.stringify(place.lastBuild),
          place.createdAt,
          place.updatedAt,
        ],
      );
      if (inserted.length === 0) continue;
      moved += 1;

      if (place.gatewayId) {
        await queryRunner.query(
          `UPDATE "gateways"
              SET "configuration" = ((COALESCE("configuration"::jsonb, '{}'::jsonb) - 'appId') || jsonb_build_object('channelId', $2::text))::json
            WHERE id = $1`,
          [place.gatewayId, place.id],
        );
      }
      await queryRunner.query(
        `UPDATE "credentials"
            SET "metadata" = jsonb_set("metadata"::jsonb, '{managedBy,kind}', '"agent_channel"')::json
          WHERE "metadata"::jsonb -> 'managedBy' ->> 'kind' = 'app_distribution'
            AND "metadata"::jsonb -> 'managedBy' ->> 'id' = $1`,
        [place.id],
      );
      await queryRunner.query(
        `UPDATE "app_builds" SET "channelId" = $1, "agentId" = $2 WHERE "appId" = $3 AND target = $4 AND "channelId" IS NULL`,
        [place.id, agentId, app.id, place.target],
      );
    }
  }

  logger?.log(`Moved ${moved} places to channels; ${skipped.length} not moved; ${conflicts.length} settings conflicts.`);
  return { moved, skipped, conflicts };
}
