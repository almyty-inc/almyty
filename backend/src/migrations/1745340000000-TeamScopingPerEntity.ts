import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-entity team-scoping rollout (Phase 0.5 of GitHub-style RBAC).
 *
 * Adds `visibility` (enum: 'org' | 'team', default 'org') and nullable
 * `teamId` (uuid FK to teams, indexed) to every user-creatable resource:
 *
 *   tools / agents / gateways / runners / credentials / apis /
 *   tools / agents / gateways / runners / credentials / apis / llm_providers
 *
 * Children of these (operations, api_schemas, tool_versions, agent_nodes,
 * workspaces, agent_runs, etc.) intentionally do NOT get their own
 * columns — they inherit visibility/teamId from their parent through
 * the FK relationship. The AccessPolicyService is parameterized on the
 * parent's columns when listing children.
 *
 * Existing rows: every row gets visibility='org', teamId=null. This is
 * the default; no behavior changes until services start calling
 * AccessPolicyService.applyListFilter for the affected entity.
 *
 * Constraint: a team-scoped resource (visibility='team') must have
 * teamId set; an org-wide resource (visibility='org') must have
 * teamId=null. Enforced via CHECK constraint per table.
 *
 * Reverse: drops every added column + check constraint + index.
 */
export class TeamScopingPerEntity1745340000000 implements MigrationInterface {
  name = 'TeamScopingPerEntity1745340000000';

  // Tables that get visibility + teamId. Listed once so up/down stay
  // symmetric and the `for ... of` loops below don't drift.
  private static readonly TABLES = [
    'tools',
    'agents',
    'gateways',
    'runners',
    'credentials',
    'apis',
    'llm_providers',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TeamScopingPerEntity1745340000000.TABLES) {
      await queryRunner.query(`
        ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS "visibility" VARCHAR(8) NOT NULL DEFAULT 'org',
        ADD COLUMN IF NOT EXISTS "teamId" UUID NULL
      `);
      // Index for the listFilter clause (teamId IN (...)).
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS ${table}_team_idx
          ON ${table} ("teamId")
          WHERE "teamId" IS NOT NULL
      `);
      // Composite index for common (orgId, visibility, teamId) listings.
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS ${table}_org_visibility_idx
          ON ${table} ("organizationId", "visibility")
      `);
      // FK to teams. Use ON DELETE SET NULL: deleting a team should
      // demote its resources to org-wide rather than cascade-delete
      // them. The team_admin can later re-park them or delete them.
      await queryRunner.query(`
        ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_team_fk
        FOREIGN KEY ("teamId") REFERENCES teams (id) ON DELETE SET NULL
      `);
      // Visibility constraint: 'team' requires teamId, 'org' forbids it.
      await queryRunner.query(`
        ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_visibility_team_chk CHECK (
          (visibility = 'team' AND "teamId" IS NOT NULL) OR
          (visibility = 'org'  AND "teamId" IS NULL)
        )
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TeamScopingPerEntity1745340000000.TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_visibility_team_chk`);
      await queryRunner.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_team_fk`);
      await queryRunner.query(`DROP INDEX IF EXISTS ${table}_org_visibility_idx`);
      await queryRunner.query(`DROP INDEX IF EXISTS ${table}_team_idx`);
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS "teamId"`);
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS "visibility"`);
    }
  }
}
