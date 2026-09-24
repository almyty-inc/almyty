import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deleting a team that still scopes resources must widen them, not fail.
 *
 * 1745340000000-TeamScopingPerEntity gave every resource table a
 * `teamId` FK to teams with ON DELETE SET NULL -- "deleting a team should
 * demote its resources to org-wide" -- and, in the same migration, a
 * CHECK that a 'team' row carries a teamId. SET NULL leaves visibility at
 * 'team', so the CHECK refused it and `DELETE FROM teams` failed for any
 * team that owned something.
 *
 * This trigger does what the FK meant: before a team row is deleted,
 * every resource scoped to it becomes org-wide (visibility 'org', teamId
 * NULL). OrganizationsService.deleteTeam demotes the rows itself first so
 * it can audit them; the trigger covers every other path, including the
 * teams removed by an organization delete cascading.
 *
 * approval_requests and approval_policies also have a "teamId" but no FK
 * to teams, so a team delete never touched them and they are left alone:
 * a dangling team id on a policy governs nothing, and widening a pending
 * approval to the whole organization is not this trigger's call.
 */
export class TeamDeleteDemotesResources1750809000000 implements MigrationInterface {
  name = 'TeamDeleteDemotesResources1750809000000';

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
    const updates = TeamDeleteDemotesResources1750809000000.TABLES.map(
      (table) => `  UPDATE ${table} SET visibility = 'org', "teamId" = NULL WHERE "teamId" = OLD.id;`,
    ).join('\n');
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION teams_demote_resources_before_delete() RETURNS trigger AS $$
      BEGIN
      ${updates}
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS teams_demote_resources_before_delete ON teams`);
    await queryRunner.query(`
      CREATE TRIGGER teams_demote_resources_before_delete
        BEFORE DELETE ON teams
        FOR EACH ROW EXECUTE FUNCTION teams_demote_resources_before_delete()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS teams_demote_resources_before_delete ON teams`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS teams_demote_resources_before_delete()`);
  }
}
