import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `normalizedEmail` to users: the canonical, alias-collapsed form of the
 * address used to dedupe signup-abuse aliases (gmail dot-injection, `+tag`
 * sub-addressing). New registrations reject/dedupe on this column.
 *
 * Backfill replicates the app-side normalization (see email-normalization.ts)
 * in SQL for existing rows:
 *   - lowercase the whole address, fold googlemail.com -> gmail.com
 *   - strip `+tag` from the local part (all domains)
 *   - strip dots from the local part on gmail-family domains
 *
 * The unique index is PARTIAL (WHERE normalizedEmail IS NOT NULL). Legacy rows
 * whose normalized form would collide with an already-populated row are left
 * NULL rather than dropped or merged — they keep working unchanged; only the
 * uniqueness invariant for NEW signups is enforced. This avoids a migration
 * that could fail on pre-existing duplicate aliases in production data.
 */
export class UserNormalizedEmail1750746000000 implements MigrationInterface {
  name = 'UserNormalizedEmail1750746000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS "normalizedEmail" character varying`,
    );

    // Compute the canonical form for every existing row. Done in one pass with
    // CTEs so the dot-strip only applies to gmail-family domains.
    await queryRunner.query(`
      WITH parts AS (
        SELECT
          id,
          lower(split_part(email, '@', 1)) AS local_raw,
          CASE
            WHEN lower(split_part(email, '@', 2)) = 'googlemail.com' THEN 'gmail.com'
            ELSE lower(split_part(email, '@', 2))
          END AS domain
        FROM users
        WHERE email LIKE '%@%'
      ),
      detagged AS (
        SELECT
          id,
          split_part(local_raw, '+', 1) AS local_notag,
          domain
        FROM parts
      ),
      normalized AS (
        SELECT
          id,
          CASE
            WHEN domain IN ('gmail.com') THEN replace(local_notag, '.', '')
            ELSE local_notag
          END AS local_final,
          domain
        FROM detagged
      ),
      candidate AS (
        SELECT
          id,
          CASE
            WHEN local_final = '' THEN NULL
            ELSE local_final || '@' || domain
          END AS norm,
          ROW_NUMBER() OVER (
            PARTITION BY
              CASE WHEN local_final = '' THEN NULL ELSE local_final || '@' || domain END
            ORDER BY id
          ) AS rn
        FROM normalized
      )
      UPDATE users u
      SET "normalizedEmail" = c.norm
      FROM candidate c
      WHERE u.id = c.id
        AND c.norm IS NOT NULL
        AND c.rn = 1
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_normalized_email"
       ON users ("normalizedEmail")
       WHERE "normalizedEmail" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_normalized_email"`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS "normalizedEmail"`);
  }
}
