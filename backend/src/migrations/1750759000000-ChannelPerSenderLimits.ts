import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give messaging-channel gateways published from an app the per-sender
 * limits new publishes now write, keeping whatever surface ceiling they
 * already carry. Web gateways were handled by 1750757000000.
 */
export class ChannelPerSenderLimits1750759000000 implements MigrationInterface {
  name = 'ChannelPerSenderLimits1750759000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "gateways" g
      SET "rateLimitConfig" = (
        COALESCE(g."rateLimitConfig"::jsonb, '{"enabled": false}'::jsonb)
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
        AND d."target" <> 'web'
        AND a."limits" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "gateways" g
      SET "rateLimitConfig" = ((g."rateLimitConfig"::jsonb) - 'perVisitorPerHour' - 'perIpPerHour')::json
      FROM "agent_app_distributions" d
      WHERE d."gatewayId" = g."id" AND d."target" <> 'web' AND g."rateLimitConfig" IS NOT NULL
    `);
  }
}
