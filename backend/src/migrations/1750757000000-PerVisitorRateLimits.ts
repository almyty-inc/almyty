import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Re-express existing web (hosted chat) distributions' rate limits per
 * visitor.
 *
 * Publishing used to fold an app's per-user and per-IP numbers into one
 * ceiling for the whole surface, so the first visitor locked everyone
 * else out for the hour. New publishes write the per-visitor shape; this
 * brings gateways that were published before the change along, from the
 * app's own limits. Messaging-channel gateways are left alone: their
 * ingress still needs a surface ceiling.
 */
export class PerVisitorRateLimits1750757000000 implements MigrationInterface {
  name = 'PerVisitorRateLimits1750757000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "gateways" g
      SET "rateLimitConfig" = (
        jsonb_build_object('enabled', false)
        || CASE WHEN COALESCE((a."limits"->>'perUserRateLimit')::int, 0) > 0
             THEN jsonb_build_object('perVisitorPerHour', (a."limits"->>'perUserRateLimit')::int)
             ELSE '{}'::jsonb END
        || CASE WHEN COALESCE((a."limits"->>'perIpRateLimit')::int, 0) > 0
             THEN jsonb_build_object('perIpPerHour', (a."limits"->>'perIpRateLimit')::int)
             ELSE '{}'::jsonb END
      )::json
      FROM "agent_app_distributions" d
      JOIN "agent_apps" a ON a."id" = d."appId"
      WHERE d."gatewayId" = g."id"
        AND d."target" = 'web'
        AND a."limits" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best effort: restore the old surface-wide fold for the same rows.
    await queryRunner.query(`
      UPDATE "gateways" g
      SET "rateLimitConfig" = (
        CASE WHEN GREATEST(COALESCE((a."limits"->>'perUserRateLimit')::int, 0), COALESCE((a."limits"->>'perIpRateLimit')::int, 0)) > 0
          THEN jsonb_build_object(
            'enabled', true,
            'requestsPerHour', GREATEST(COALESCE((a."limits"->>'perUserRateLimit')::int, 0), COALESCE((a."limits"->>'perIpRateLimit')::int, 0)),
            'requestsPerMinute', GREATEST(1, CEIL(GREATEST(COALESCE((a."limits"->>'perUserRateLimit')::int, 0), COALESCE((a."limits"->>'perIpRateLimit')::int, 0)) / 60.0))
          )
          ELSE jsonb_build_object('enabled', false) END
      )::json
      FROM "agent_app_distributions" d
      JOIN "agent_apps" a ON a."id" = d."appId"
      WHERE d."gatewayId" = g."id"
        AND d."target" = 'web'
        AND a."limits" IS NOT NULL
    `);
  }
}
