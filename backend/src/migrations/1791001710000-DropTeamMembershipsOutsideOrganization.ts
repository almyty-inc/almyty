import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop team memberships held by people who are no longer in the team's
 * organization.
 *
 * Removing a member from an organization (or a member leaving it) deleted
 * the organization membership and left their user_teams rows behind, so a
 * team went on counting them: the "Everyone" team said 9 members while the
 * organization had 1. OrganizationsService.removeMember now deletes those
 * rows in the same transaction; this clears the ones left before it did.
 *
 * Only rows with no user_organizations row at all for the team's
 * organization go. A deactivated member keeps their membership row, and so
 * keeps their teams for when they are reactivated.
 */
export class DropTeamMembershipsOutsideOrganization1791001710000 implements MigrationInterface {
  name = 'DropTeamMembershipsOutsideOrganization1791001710000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "user_teams" ut
      USING "teams" t
      WHERE t."id" = ut."teamId"
        AND NOT EXISTS (
          SELECT 1 FROM "user_organizations" uo
          WHERE uo."userId" = ut."userId"
            AND uo."organizationId" = t."organizationId"
        )
    `);
  }

  public async down(): Promise<void> {
    // The deleted rows named people outside the organization; there is
    // nothing to restore.
  }
}
