import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Generated tools take their API's scope.
 *
 * Tool generation wrote every tool of a team API org-wide (only a private
 * API's tools took its scope), so a team's API was listed to the whole
 * organization through its tools and refused only when one ran. Generation
 * now copies the API's visibility and team onto the tool, on every
 * regeneration and when the API's scope changes (generatedToolScope).
 *
 * Existing rows: every generated tool is aligned with the API it was made
 * from -- directly (`apiId`) or through its operation. A team API's tools
 * become that team's, an org API's org-wide, a private API's private to the
 * API's owner. An API whose own row breaks its scope rule (team without a
 * team, private without an owner) is left alone rather than guessed at.
 * Hand-made tools keep the scope their author chose.
 *
 * `down` does nothing: the old scope was the defect, and nothing records it.
 */
export class GeneratedToolsFollowApiScope1750812730000 implements MigrationInterface {
  name = 'GeneratedToolsFollowApiScope1750812730000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "tools" t
         SET "visibility" = a."visibility",
             "teamId" = CASE WHEN a."visibility" = 'team' THEN a."teamId" ELSE NULL END,
             "createdBy" = CASE WHEN a."visibility" = 'private' THEN a."ownerUserId"::varchar ELSE t."createdBy" END
        FROM "apis" a
       WHERE t."generated" = true
         AND a."organizationId" = t."organizationId"
         AND a."id" = COALESCE(t."apiId", (SELECT o."apiId" FROM "operations" o WHERE o."id" = t."operationId"))
         AND (a."visibility" <> 'team' OR a."teamId" IS NOT NULL)
         AND (a."visibility" <> 'private' OR a."ownerUserId" IS NOT NULL)
         AND (
           t."visibility" IS DISTINCT FROM a."visibility"
           OR t."teamId" IS DISTINCT FROM (CASE WHEN a."visibility" = 'team' THEN a."teamId" ELSE NULL END)
           OR (a."visibility" = 'private' AND t."createdBy" IS DISTINCT FROM a."ownerUserId"::varchar)
         )
    `);
  }

  public async down(): Promise<void> {
    // Nothing to restore: the previous scope was the defect.
  }
}
