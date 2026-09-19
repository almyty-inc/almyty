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
    // Collapse existing duplicates first. The index cannot be created while
    // two rows share a slug, and a deployment that already has a collision
    // is exactly the deployment this index is meant to protect -- so
    // creating it blind aborts the migration and, because the deploy is
    // fail-closed, blocks the rollout entirely. That is what happened on
    // staging.
    //
    // The earliest claim keeps the address, ordered by createdAt then id so
    // the outcome is deterministic and a re-run is a no-op. Later claimants
    // keep their gateway and their configuration; only the slug moves, to
    // `<slug>-<first 8 of id>`, which cannot itself collide. Nothing is
    // deleted: a duplicate slug means both tenants' hosted chat is already
    // dark (the reader fails closed on an ambiguous slug), so this restores
    // one and gives the other a working address rather than removing a row
    // somebody owns.
    //
    // `configuration` is plain json, so the write goes through jsonb and
    // back; -> and ->> are immutable either way.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY ("configuration" -> 'hostedChat' ->> 'slug')
                 ORDER BY "createdAt", id
               ) AS rn
          FROM "gateways"
         WHERE "type" = 'hosted_chat'
           AND ("configuration" -> 'hostedChat' ->> 'slug') IS NOT NULL
      )
      UPDATE "gateways" g
         SET "configuration" = jsonb_set(
               g."configuration"::jsonb,
               '{hostedChat,slug}',
               to_jsonb(
                 (g."configuration" -> 'hostedChat' ->> 'slug') || '-' || left(g.id::text, 8)
               )
             )::json
        FROM ranked r
       WHERE g.id = r.id
         AND r.rn > 1
    `);

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
