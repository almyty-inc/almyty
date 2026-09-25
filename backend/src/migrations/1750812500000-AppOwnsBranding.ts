import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Branding has one home: the app.
 *
 * A hosted chat used to carry its own copy of the look (name, colour,
 * greeting, theme, logo, suggested prompts, AI disclosure, white label)
 * in `gateways.configuration -> 'hostedChat'`, editable on the gateway
 * page, while the app it was published from carried another. The public
 * page now reads branding from the app on every request
 * (hostedChatBlockFor), so this moves the data there:
 *
 * 1. A hosted chat gateway no app owns gets one: an app named after the
 *    surface, answering with the gateway's agent, with a `web` place
 *    pointing at the gateway (live when the gateway is active). Its slug
 *    is the surface's address, suffixed with the gateway id when the
 *    organization already has an app of that name. Who may use it and
 *    what visitors may do with their data come along.
 * 2. Every hosted chat's branding is merged into its app's. Where both
 *    set a field, whichever row was saved last wins: an edit on the
 *    gateway page after publishing is newer than the app's copy, and an
 *    app edit after publishing is newer than the gateway's.
 * 3. The branding fields leave the gateway: the hostedChat block keeps
 *    its address and sign-in rule, and the top-level `branding` copy
 *    publishing used to write goes.
 *
 * The columns are `json`, so each statement goes through `jsonb`. Every
 * step is a no-op on a second run.
 *
 * `down()` copies each app's branding back onto its hosted chat. Apps
 * created by step 1 are left in place.
 */
export class AppOwnsBranding1750812500000 implements MigrationInterface {
  name = 'AppOwnsBranding1750812500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        g record;
        hc jsonb;
        base text;
        chosen text;
        new_app uuid;
      BEGIN
        FOR g IN
          SELECT gw.id, gw."organizationId", gw.name, gw.description, gw."agentId", gw.status,
                 COALESCE(gw.configuration::jsonb -> 'hostedChat', '{}'::jsonb) AS hc
            FROM "gateways" gw
           WHERE gw."type" = 'hosted_chat'
             AND NOT EXISTS (SELECT 1 FROM "agent_app_distributions" d WHERE d."gatewayId" = gw.id)
           ORDER BY gw."createdAt", gw.id
        LOOP
          hc := g.hc;
          base := lower(COALESCE(NULLIF(hc ->> 'slug', ''), 'chat-' || left(g.id::text, 8)));
          chosen := base;
          IF EXISTS (SELECT 1 FROM "agent_apps" a WHERE a."organizationId" = g."organizationId" AND a.slug = chosen) THEN
            chosen := base || '-' || left(g.id::text, 8);
          END IF;

          INSERT INTO "agent_apps"
            ("id", "organizationId", "name", "slug", "description", "agentIds", "branding", "authMode", "privacy", "isActive")
          VALUES (
            gen_random_uuid(),
            g."organizationId",
            COALESCE(NULLIF(hc ->> 'appName', ''), g.name),
            chosen,
            g.description,
            CASE WHEN g."agentId" IS NULL THEN '{}'::uuid[] ELSE ARRAY[g."agentId"] END,
            '{}'::json,
            COALESCE(NULLIF(hc ->> 'authMode', ''), 'public_link'),
            (SELECT jsonb_object_agg(key, value) FROM jsonb_each(hc)
              WHERE key IN ('visitorCanDelete', 'visitorCanExport', 'visitorMemory'))::json,
            true
          )
          RETURNING "id" INTO new_app;

          INSERT INTO "agent_app_distributions" ("id", "organizationId", "appId", "target", "status", "gatewayId", "configuration")
          VALUES (
            gen_random_uuid(),
            g."organizationId",
            new_app,
            'web',
            CASE WHEN g.status = 'active' THEN 'live' ELSE 'draft' END,
            g.id,
            '{}'::json
          );
        END LOOP;
      END
      $$
    `);

    await queryRunner.query(`
      UPDATE "agent_apps" a
         SET "branding" = (
               CASE WHEN g."updatedAt"::timestamptz > a."updatedAt"
                    THEN COALESCE(a."branding"::jsonb, '{}'::jsonb) || gb.branding
                    ELSE gb.branding || COALESCE(a."branding"::jsonb, '{}'::jsonb)
               END
             )::json
        FROM "agent_app_distributions" d
        JOIN "gateways" g ON g.id = d."gatewayId"
        CROSS JOIN LATERAL (
          SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) AS branding
            FROM jsonb_each(COALESCE(g.configuration::jsonb -> 'hostedChat', '{}'::jsonb))
           WHERE key IN ('appName', 'primaryColor', 'greeting', 'theme', 'logoUrl', 'suggestedPrompts', 'aiDisclosure', 'whiteLabel')
        ) gb
       WHERE d."appId" = a.id
         AND g."type" = 'hosted_chat'
         AND gb.branding <> '{}'::jsonb
    `);

    await queryRunner.query(`
      UPDATE "gateways" g
         SET "configuration" = (
               CASE WHEN g."type" = 'hosted_chat' AND jsonb_typeof(g.configuration::jsonb -> 'hostedChat') = 'object'
                    THEN jsonb_set(
                           g.configuration::jsonb - 'branding',
                           '{hostedChat}',
                           (g.configuration::jsonb -> 'hostedChat')
                             - 'appName' - 'primaryColor' - 'greeting' - 'theme'
                             - 'logoUrl' - 'suggestedPrompts' - 'aiDisclosure' - 'whiteLabel'
                         )
                    ELSE g.configuration::jsonb - 'branding'
               END
             )::json
       WHERE g.configuration IS NOT NULL
         AND (
           g.configuration::jsonb ? 'branding'
           OR (g."type" = 'hosted_chat' AND (g.configuration::jsonb -> 'hostedChat') ?| ARRAY[
             'appName', 'primaryColor', 'greeting', 'theme', 'logoUrl', 'suggestedPrompts', 'aiDisclosure', 'whiteLabel'
           ])
         )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "gateways" g
         SET "configuration" = jsonb_set(
               COALESCE(g.configuration::jsonb, '{}'::jsonb),
               '{hostedChat}',
               COALESCE(g.configuration::jsonb -> 'hostedChat', '{}'::jsonb) || COALESCE(a."branding"::jsonb, '{}'::jsonb)
             )::json
        FROM "agent_app_distributions" d
        JOIN "agent_apps" a ON a.id = d."appId"
       WHERE d."gatewayId" = g.id
         AND g."type" = 'hosted_chat'
    `);
  }
}
