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
    // Canonical owner: an ACTIVE claimant outranks an inactive one, and
    // among equals the earliest wins -- ordered by status, then createdAt,
    // then id, so the outcome is deterministic and a re-run is a no-op.
    // Ordering by age alone would be wrong in the case that matters: if the
    // first claimant had been deactivated and a later one is serving live
    // traffic, age would take the address off the running app. Other
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
      DO $$
      DECLARE
        loser RECORD;
        candidate text;
        attempt int;
      BEGIN
        FOR loser IN
          SELECT id, slug FROM (
            SELECT id,
                   ("configuration" -> 'hostedChat' ->> 'slug') AS slug,
                   ROW_NUMBER() OVER (
                     PARTITION BY ("configuration" -> 'hostedChat' ->> 'slug')
                     ORDER BY ("status" = 'active') DESC, "createdAt", id
                   ) AS rn
              FROM "gateways"
             WHERE "type" = 'hosted_chat'
               AND ("configuration" -> 'hostedChat' ->> 'slug') IS NOT NULL
          ) ranked
          WHERE rn > 1
        LOOP
          -- The id prefix alone is not collision-proof: someone may already
          -- hold '<slug>-<prefix>', and two ids can share eight characters.
          -- Ask the table, and keep asking until the answer is free. Each
          -- iteration re-reads live state, so rows renamed earlier in this
          -- same loop are accounted for.
          candidate := loser.slug || '-' || left(loser.id::text, 8);
          attempt := 0;
          WHILE EXISTS (
            SELECT 1 FROM "gateways"
             WHERE "type" = 'hosted_chat'
               AND ("configuration" -> 'hostedChat' ->> 'slug') = candidate
          ) LOOP
            attempt := attempt + 1;
            candidate := loser.slug || '-' || left(loser.id::text, 8) || '-' || attempt::text;
          END LOOP;

          UPDATE "gateways"
             SET "configuration" = jsonb_set(
                   "configuration"::jsonb,
                   '{hostedChat,slug}',
                   to_jsonb(candidate)
                 )::json
           WHERE id = loser.id;
        END LOOP;
      END $$;
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
