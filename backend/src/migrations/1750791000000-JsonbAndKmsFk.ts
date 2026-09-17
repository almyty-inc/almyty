import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two type mismatches between the entities and the schema.
 *
 * 1. organizations.settings is `json`, and the invite flow queries it
 *    with the containment operator:
 *
 *      org.settings->'pendingInvites' @> :needle
 *
 *    Postgres has no `@>` for `json` -- containment is jsonb-only, with
 *    no implicit cast -- so both call sites threw
 *    `operator does not exist: json @> unknown`. Those two sites are
 *    acceptInvite() and getInviteDetails(), i.e. the entire invite
 *    landing and accept path for anyone not already a member. The unit
 *    specs mock the query builder, so nothing caught it.
 *
 * 2. org_kms_configs.organizationId is `character varying` with no
 *    foreign key, while the entity declares a uuid relation with
 *    onDelete: CASCADE. TypeORM's CASCADE is DDL, so with no FK it does
 *    nothing: deleting an organization left an orphaned row still
 *    holding that org's wrapped Data Encryption Key. It is also the only
 *    relation in the codebase with no backing FK, and the FK cannot be
 *    added until the type matches organizations.id.
 */
export class JsonbAndKmsFk1750791000000 implements MigrationInterface {
  name = 'JsonbAndKmsFk1750791000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizations"
      ALTER COLUMN "settings" TYPE jsonb USING "settings"::jsonb
    `);

    // Any row whose organization is already gone would fail the FK, and
    // it is an orphan holding a wrapped key for an organization that no
    // longer exists -- exactly what the missing FK was supposed to
    // prevent.
    await queryRunner.query(`
      DELETE FROM "org_kms_configs"
      WHERE "organizationId" NOT IN (SELECT "id"::text FROM "organizations")
    `);

    await queryRunner.query(`
      ALTER TABLE "org_kms_configs"
      ALTER COLUMN "organizationId" TYPE uuid USING "organizationId"::uuid
    `);

    await queryRunner.query(`
      ALTER TABLE "org_kms_configs"
      ADD CONSTRAINT "FK_org_kms_configs_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "org_kms_configs" DROP CONSTRAINT IF EXISTS "FK_org_kms_configs_organization"
    `);
    await queryRunner.query(`
      ALTER TABLE "org_kms_configs"
      ALTER COLUMN "organizationId" TYPE character varying USING "organizationId"::text
    `);
    await queryRunner.query(`
      ALTER TABLE "organizations"
      ALTER COLUMN "settings" TYPE json USING "settings"::json
    `);
  }
}
