import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make the database enforce two uniqueness rules the entities already
 * claim and only application code was checking.
 *
 * `runners`: the entity declares @Index(['ownerUserId','organizationId'],
 * { unique: true }) and the table has a THREE-column constraint including
 * name, so two runners for one account are accepted as long as the names
 * differ. The single-runner cap lives in runner.service.ts as a read then
 * a write, which two concurrent registrations both pass. Afterwards
 * findOne() returns an arbitrary row and work routes to whichever runner
 * Postgres happened to pick -- possibly an offline one.
 *
 * `agent_app_distributions`: the entity declares the pair unique and the
 * migration created a plain index, so duplicate rows are possible. The
 * signer resolves its credential with findOne({ appId, target }), so a
 * duplicate means a build signed with the wrong distribution's
 * credential, or credentialFor() returning null and the build shipping
 * unsigned. Silent either way.
 *
 * Existing duplicates are collapsed before the index is added, keeping
 * the most recently updated row: adding a unique index to a table that
 * already violates it fails the whole migration, and a deploy that dies
 * halfway through is worse than the drift.
 */
export class UniquenessParity1750790000000 implements MigrationInterface {
  name = 'UniquenessParity1750790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── runners: one per (owner, organization) ──
    await queryRunner.query(`
      DELETE FROM runners r
      USING runners keep
      WHERE r."ownerUserId" = keep."ownerUserId"
        AND r."organizationId" = keep."organizationId"
        AND r.id <> keep.id
        AND (keep."updatedAt", keep.id) > (r."updatedAt", r.id)
    `);
    await queryRunner.query(`ALTER TABLE runners DROP CONSTRAINT IF EXISTS runners_owner_org_name_unique`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runners_owner_org"
      ON runners ("ownerUserId", "organizationId")
    `);

    // ── agent_app_distributions: one per (app, target) ──
    await queryRunner.query(`
      DELETE FROM "agent_app_distributions" d
      USING "agent_app_distributions" keep
      WHERE d."appId" = keep."appId"
        AND d.target = keep.target
        AND d.id <> keep.id
        AND (keep."updatedAt", keep.id) > (d."updatedAt", d.id)
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_app_distributions_app_target"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_agent_app_distributions_app_target"
      ON "agent_app_distributions" ("appId", "target")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverses exactly what up() created, back to the shapes that were
    // there before. The collapsed duplicate rows are not restored, and
    // cannot be -- noted here rather than pretended otherwise.
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_agent_app_distributions_app_target"`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_agent_app_distributions_app_target"
      ON "agent_app_distributions" ("appId", "target")
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_runners_owner_org"`);
    await queryRunner.query(`
      ALTER TABLE runners
      ADD CONSTRAINT runners_owner_org_name_unique UNIQUE ("ownerUserId", "organizationId", name)
    `);
  }
}
