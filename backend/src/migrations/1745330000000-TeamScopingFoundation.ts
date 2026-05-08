import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 0 of the team-scoping rollout (GitHub-style).
 *
 * What this migration does:
 *   1. Adds `is_default` (boolean, default false) on `teams`. Each org
 *      gets exactly one row with is_default=true; that team is the
 *      "Everyone" pool for org members who haven't been placed into a
 *      narrower team. Created on org creation; cannot be deleted.
 *   2. Creates a default team for every existing organization
 *      (idempotent — only creates if no existing team is marked
 *      is_default for that org).
 *   3. Joins every existing org member into their org's default team
 *      as `user_teams.role` = 'member'. Org owners are joined as
 *      'lead' (= team_admin).
 *
 * What this migration does NOT do:
 *   - It does not add `visibility` or `teamId` columns to any
 *     resource entity (Tool, Agent, Gateway, etc.). Those land in
 *     per-entity follow-up migrations so each can be reviewed and
 *     deployed independently.
 *   - It does not change any existing behavior. The default team
 *     simply exists; no service is yet using it for filtering.
 *
 * Reverse:
 *   - Drops the column. Default-team rows remain (harmless — they're
 *     just teams without the marker).
 */
export class TeamScopingFoundation1745330000000 implements MigrationInterface {
  name = 'TeamScopingFoundation1745330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Schema: is_default flag on teams.
    await queryRunner.query(`
      ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT FALSE
    `);
    // Partial unique index: at most one default team per org.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS teams_one_default_per_org
        ON teams ("organizationId")
        WHERE "isDefault" = TRUE
    `);

    // 2. Backfill: one default team per org that doesn't already have one.
    await queryRunner.query(`
      INSERT INTO teams (id, name, description, "organizationId", "isActive", "isDefault", "createdAt", "updatedAt")
      SELECT
        gen_random_uuid(),
        'Everyone',
        'Default team — every organization member is automatically a member.',
        o.id,
        TRUE,
        TRUE,
        NOW(),
        NOW()
      FROM organizations o
      WHERE NOT EXISTS (
        SELECT 1 FROM teams t WHERE t."organizationId" = o.id AND t."isDefault" = TRUE
      )
    `);

    // 3. Backfill: join every active org member into their org's default team.
    //    user_teams.role uses TeamRole enum: 'lead' (admin) or 'member'.
    //    Org owners → lead. Org admins/members → member.
    await queryRunner.query(`
      INSERT INTO user_teams (id, "userId", "teamId", role, "isActive", "joinedAt")
      SELECT
        gen_random_uuid(),
        uo."userId",
        t.id,
        CASE WHEN uo.role = 'owner' THEN 'lead' ELSE 'member' END,
        TRUE,
        NOW()
      FROM user_organizations uo
      JOIN teams t ON t."organizationId" = uo."organizationId" AND t."isDefault" = TRUE
      WHERE uo."isActive" = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM user_teams ut
          WHERE ut."userId" = uo."userId" AND ut."teamId" = t.id
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS teams_one_default_per_org`);
    await queryRunner.query(`ALTER TABLE teams DROP COLUMN IF EXISTS "isDefault"`);
    // Default-team backfill rows are intentionally left in place;
    // dropping them would orphan unrelated team work that may have been
    // done against the default team in the meantime.
  }
}
