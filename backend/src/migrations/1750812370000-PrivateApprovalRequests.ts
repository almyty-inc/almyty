import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An approval a private agent asks for is its owner's alone: a 'private'
 * visibility on approval_requests, with the owner it belongs to.
 *
 * A private request has an owner and no team; org and team requests carry
 * no owner, as before. The owner column has a foreign key like every other
 * owner column: deleting the account deletes the requests only it could
 * see or decide.
 */
export class PrivateApprovalRequests1750812370000 implements MigrationInterface {
  name = 'PrivateApprovalRequests1750812370000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS "ownerUserId" uuid NULL`);
    await queryRunner.query(`
      ALTER TABLE approval_requests
        ADD CONSTRAINT approval_requests_owner_fk FOREIGN KEY ("ownerUserId") REFERENCES users(id) ON DELETE CASCADE
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS approval_requests_owner_idx ON approval_requests ("ownerUserId") WHERE "ownerUserId" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_visibility_team_chk`);
    await queryRunner.query(`
      ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_visibility_team_chk CHECK (
        (visibility = 'team' AND "teamId" IS NOT NULL AND "ownerUserId" IS NULL) OR
        (visibility = 'org' AND "teamId" IS NULL AND "ownerUserId" IS NULL) OR
        (visibility = 'private' AND "teamId" IS NULL AND "ownerUserId" IS NOT NULL)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM approval_requests WHERE visibility = 'private'`);
    await queryRunner.query(`ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_visibility_team_chk`);
    await queryRunner.query(`
      ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_visibility_team_chk CHECK (
        (visibility = 'team' AND "teamId" IS NOT NULL) OR
        (visibility = 'org'  AND "teamId" IS NULL)
      )
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS approval_requests_owner_idx`);
    await queryRunner.query(`ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_owner_fk`);
    await queryRunner.query(`ALTER TABLE approval_requests DROP COLUMN IF EXISTS "ownerUserId"`);
  }
}
