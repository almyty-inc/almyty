import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `agents."createdBy"` is the owner column every ownership rule reads a
 * user id from. `create_agent` wrote the string 'system' there for the
 * temporary agents it makes; it now records the parent run's user, or
 * null for a run without one.
 *
 * Existing 'system' rows get the same: the parent run's user where the
 * temporary agent's parent run is known and has one, null everywhere
 * else. Both columns are varchar, so no cast can fail on a stray value.
 */
export class AgentOwnerNotSystem1750811100000 implements MigrationInterface {
  name = 'AgentOwnerNotSystem1750811100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "agents" a
         SET "createdBy" = r."userId"
        FROM "agent_runs" r
       WHERE a."createdBy" = 'system'
         AND a."isTemporary" = true
         AND a."parentRunId" = r."id"::text
         AND r."userId" IS NOT NULL
    `);
    await queryRunner.query(`
      UPDATE "agents" SET "createdBy" = NULL WHERE "createdBy" = 'system'
    `);
  }

  public async down(): Promise<void> {
    // Nothing to restore: 'system' named no one.
  }
}
