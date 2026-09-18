import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make the hosted-chat slug claim atomic.
 *
 * `{slug}.almyty.app` is one public address for the whole deployment,
 * not a tenant-scoped name, and the only thing reserving it was a SELECT
 * followed by an INSERT. Two organizations publishing the same app name
 * at the same moment -- or one double-click -- both pass the SELECT and
 * both land. The public reader fails closed on an ambiguous slug, so the
 * result is the hosted chat going dark for both tenants until a row is
 * removed by hand.
 *
 * A partial unique expression index moves the decision into Postgres:
 * the loser of the race gets a 23505 the service turns into a conflict
 * response. `gateways.configuration` is plain `json`, but `json -> text`
 * and `json ->> text` are both immutable, so the expression is indexable
 * as written -- and it is written exactly as the lookup in
 * HostedChatService.findBySlug spells it, so the index can serve that
 * query too.
 *
 * Scoped to type = 'hosted_chat' and to rows that actually carry a slug:
 * every other gateway type keeps an unconstrained configuration blob.
 * Status is deliberately not part of the predicate, because a
 * deactivated gateway still holds its address -- which is what the
 * service's own availability check assumes.
 */
export class HostedChatSlugUniqueness1750797000000 implements MigrationInterface {
  name = 'HostedChatSlugUniqueness1750797000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_gateways_hosted_chat_slug"
      ON "gateways" ((("configuration" -> 'hostedChat' ->> 'slug')))
      WHERE "type" = 'hosted_chat'
        AND ("configuration" -> 'hostedChat' ->> 'slug') IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_gateways_hosted_chat_slug"`);
  }
}
