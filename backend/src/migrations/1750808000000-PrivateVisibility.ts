import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A third visibility tier, 'private' ("just me"), on every resource that
 * already has 'org' | 'team' (see 1745340000000-TeamScopingPerEntity).
 *
 * A private row is visible to and usable by its owner only, so every
 * table needs an owner column the policy can compare against:
 *
 *   runners, credentials          ownerUserId   (already present)
 *   agents, tools                 createdBy     (already present)
 *   apis, gateways, llm_providers ownerUserId   (added here)
 *
 * The new ownerUserId columns are plain nullable uuids with no FK:
 * existing rows have no recorded creator, and an 'org' or 'team' row
 * does not need one.
 *
 * The per-table CHECK is replaced so that 'private' is allowed, carries
 * no teamId, and cannot exist without an owner -- a private row with no
 * owner would be nobody's, and the policy refuses those to everyone.
 */
export class PrivateVisibility1750808000000 implements MigrationInterface {
  name = 'PrivateVisibility1750808000000';

  private static readonly OWNER_COLUMN: Record<string, string> = {
    runners: 'ownerUserId',
    credentials: 'ownerUserId',
    agents: 'createdBy',
    tools: 'createdBy',
    apis: 'ownerUserId',
    gateways: 'ownerUserId',
    llm_providers: 'ownerUserId',
  };

  private static readonly NEW_OWNER_COLUMN_TABLES = ['apis', 'gateways', 'llm_providers'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of PrivateVisibility1750808000000.NEW_OWNER_COLUMN_TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "ownerUserId" UUID NULL`);
    }
    for (const [table, owner] of Object.entries(PrivateVisibility1750808000000.OWNER_COLUMN)) {
      await queryRunner.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_visibility_team_chk`);
      await queryRunner.query(`
        ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_visibility_team_chk CHECK (
          (visibility = 'team'    AND "teamId" IS NOT NULL) OR
          (visibility = 'org'     AND "teamId" IS NULL) OR
          (visibility = 'private' AND "teamId" IS NULL AND "${owner}" IS NOT NULL)
        )
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS ${table}_private_owner_idx
          ON ${table} ("organizationId", "${owner}")
          WHERE visibility = 'private'
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of Object.keys(PrivateVisibility1750808000000.OWNER_COLUMN)) {
      await queryRunner.query(`DROP INDEX IF EXISTS ${table}_private_owner_idx`);
      // Private rows fall back to org-wide only if we must; refuse to
      // silently widen them, so the down migration deletes nothing and
      // fails loudly on the CHECK if any private rows remain.
      await queryRunner.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_visibility_team_chk`);
      await queryRunner.query(`
        ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_visibility_team_chk CHECK (
          (visibility = 'team' AND "teamId" IS NOT NULL) OR
          (visibility = 'org'  AND "teamId" IS NULL)
        )
      `);
    }
    for (const table of PrivateVisibility1750808000000.NEW_OWNER_COLUMN_TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS "ownerUserId"`);
    }
  }
}
