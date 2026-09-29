import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each gateway serves one protocol. A gateway of type `tools` served MCP,
 * UTCP and Agent Skills at one address; each becomes three gateways with
 * the same tools and the same scope:
 *
 *  - MCP: the row itself. It keeps its id, name, address (endpoint), tools,
 *    access keys, auth settings and history, and gains the MCP transport.
 *  - UTCP: a new row named "<name> UTCP" at "<endpoint>-utcp", with a copy
 *    of the tool attachments and of the auth settings. An access key is
 *    bound to one gateway and shown once, so none is copied: its owner
 *    issues one on the gateway's page.
 *  - Skills: a new row named "<name> Skills" at "<endpoint>-skills", with a
 *    copy of the tool attachments and the default auth row every new
 *    gateway gets. Skills are installed with the owner's own sign-in, so it
 *    needs no key.
 *
 * An address already taken in the organization gets "-2", "-3", ... after
 * the suffix. `gateways.type` is a varchar, so no enum value is dropped.
 * down() does not merge the gateways back: which rows came from a split is
 * not recorded, and the new rows may have keys of their own by then.
 */
export class SplitToolsGateways1750813760000 implements MigrationInterface {
  name = 'SplitToolsGateways1750813760000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        g RECORD;
        proto RECORD;
        candidate TEXT;
        n INT;
        new_id UUID;
      BEGIN
        FOR g IN SELECT * FROM "gateways" WHERE "type" = 'tools' ORDER BY "createdAt", "id" LOOP
          FOR proto IN
            SELECT * FROM (VALUES
              ('utcp', ' UTCP', '-utcp', '{"protocol": "http"}'::jsonb, 1),
              ('skills', ' Skills', '-skills', '{}'::jsonb, 2)
            ) AS p("type", "nameSuffix", "endpointSuffix", "config", "ord")
            ORDER BY "ord"
          LOOP
            candidate := g."endpoint" || proto."endpointSuffix";
            n := 1;
            WHILE EXISTS (
              SELECT 1 FROM "gateways" WHERE "organizationId" = g."organizationId" AND "endpoint" = candidate
            ) LOOP
              n := n + 1;
              candidate := g."endpoint" || proto."endpointSuffix" || '-' || n;
            END LOOP;

            new_id := gen_random_uuid();
            INSERT INTO "gateways" (
              "id", "name", "description", "kind", "type", "agentId", "status", "organizationId",
              "visibility", "teamId", "ownerUserId", "endpoint", "configuration", "rateLimitConfig",
              "corsConfig", "webhooks", "requestTimeout", "maxRetries", "customHeaders", "healthCheck",
              "metadata", "isHealthy", "isSystem", "createdAt", "updatedAt"
            ) VALUES (
              new_id, g."name" || proto."nameSuffix", g."description", 'tool', proto."type", NULL, g."status",
              g."organizationId", g."visibility", g."teamId", g."ownerUserId", candidate,
              (COALESCE(g."configuration"::jsonb, '{}'::jsonb) - 'transport' || proto."config")::json,
              g."rateLimitConfig", g."corsConfig", g."webhooks", g."requestTimeout", g."maxRetries",
              g."customHeaders", g."healthCheck", g."metadata", g."isHealthy", false, now(), now()
            );

            INSERT INTO "gateway_tools" (
              "id", "gatewayId", "toolId", "isActive", "overrides", "permissions", "transformations",
              "securityPolicy", "metadata"
            )
            SELECT gen_random_uuid(), new_id, gt."toolId", gt."isActive", gt."overrides", gt."permissions",
                   gt."transformations", gt."securityPolicy", gt."metadata"
              FROM "gateway_tools" gt
             WHERE gt."gatewayId" = g."id";

            IF proto."type" = 'utcp' THEN
              INSERT INTO "gateway_auth" (
                "id", "gatewayId", "type", "isRequired", "isActive", "configuration", "validationRules",
                "errorResponses", "metadata"
              )
              SELECT gen_random_uuid(), new_id, ga."type", ga."isRequired", ga."isActive", ga."configuration",
                     ga."validationRules", ga."errorResponses", ga."metadata"
                FROM "gateway_auth" ga
               WHERE ga."gatewayId" = g."id";
            ELSE
              INSERT INTO "gateway_auth" (
                "id", "gatewayId", "type", "isRequired", "isActive", "configuration", "validationRules",
                "errorResponses"
              ) VALUES (
                gen_random_uuid(), new_id, 'api_key', true, true,
                '{"keyHeader": "x-api-key", "keyQuery": "api_key", "defaultScopes": ["gateway:use"]}'::json,
                '{"minKeyLength": 32, "maxKeyLength": 128, "keyFormat": "^[a-zA-Z0-9_-]+$"}'::json,
                '{"unauthorized": {"code": 401, "message": "API key is required"}, "invalid": {"code": 401, "message": "Invalid API key"}}'::json
              );
            END IF;
          END LOOP;

          UPDATE "gateways"
             SET "type" = 'mcp',
                 "kind" = 'tool',
                 "configuration" = (COALESCE("configuration"::jsonb, '{}'::jsonb) || '{"transport": "http"}'::jsonb)::json
           WHERE "id" = g."id";
        END LOOP;
      END
      $$;
    `);
  }

  public async down(): Promise<void> {
    // Which gateways came from a split is not recorded; nothing to undo.
  }
}
