import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One name per agent in an organization; case and surrounding spaces do not
 * make two names different (AgentsService.assertNameFree checks the same).
 *
 * Agents that already share a name are renamed first, so the index can be
 * built on any existing data. In each group of same-named agents the oldest
 * (by "createdAt", then id) keeps its name; each of the others, oldest
 * first, gets " (2)", " (3)", ... -- the first suffix no agent in the
 * organization has yet. Nothing is deleted.
 */
export class UniqueAgentNames1791001200000 implements MigrationInterface {
  name = 'UniqueAgentNames1791001200000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      DECLARE
        r record;
        n integer;
        candidate text;
      BEGIN
        FOR r IN
          SELECT id, "organizationId", name
          FROM (
            SELECT id, "organizationId", name,
                   row_number() OVER (
                     PARTITION BY "organizationId", LOWER(TRIM(name))
                     ORDER BY "createdAt", id
                   ) AS rn
            FROM "agents"
          ) ranked
          WHERE rn > 1
          ORDER BY "organizationId", LOWER(TRIM(name)), rn
        LOOP
          n := 2;
          LOOP
            candidate := LEFT(TRIM(r.name), 240) || ' (' || n || ')';
            EXIT WHEN NOT EXISTS (
              SELECT 1 FROM "agents"
              WHERE "organizationId" = r."organizationId"
                AND LOWER(TRIM(name)) = LOWER(candidate)
            );
            n := n + 1;
          END LOOP;
          UPDATE "agents" SET name = candidate WHERE id = r.id;
        END LOOP;
      END $$;
    `);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_agents_org_name_unique" ON "agents" ("organizationId", LOWER(TRIM(name)))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_agents_org_name_unique"`);
  }
}
