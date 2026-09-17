import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Real uniqueness behind two check-then-insert paths.
 *
 * `syncFromProvider` snapshots the existing cards into a Map and then
 * inserts any vendor id the map lacks. Its dedup guard is a
 * process-local Map, and both racing call sites bypass it anyway: the
 * user-facing POST /sync calls the service directly, and so does the
 * background sweep. Clicking "Sync models" while the sweep covers that
 * provider gave two cards for one model -- duplicate router candidates,
 * a model listed twice, and a pricing feed that updated only one of
 * them.
 *
 * `registerVersion` has the same shape with a network read of the
 * manifest holding the window open for seconds, so a double-click on
 * "Register version" produced two rows for one registry URI, after which
 * the duplicate check returned an arbitrary one and the in-use teardown
 * guard counted deployments against a single copy.
 *
 * Neither table had more than a non-unique index, so nothing caught it.
 */
export class CatalogUniqueness1750793000000 implements MigrationInterface {
  name = 'CatalogUniqueness1750793000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fold any duplicates already written, keeping the oldest row so
    // anything referencing it by id still resolves.
    await queryRunner.query(`
      DELETE FROM models a
       USING models b
       WHERE a."organizationId" = b."organizationId"
         AND a."providerId" IS NOT DISTINCT FROM b."providerId"
         AND a."vendorModelId" = b."vendorModelId"
         AND a."createdAt" > b."createdAt"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS models_org_provider_vendor_uq
      ON models ("organizationId", "providerId", "vendorModelId")
    `);

    await queryRunner.query(`
      DELETE FROM model_versions a
       USING model_versions b
       WHERE a."organizationId" = b."organizationId"
         AND a."registryUri" = b."registryUri"
         AND a."createdAt" > b."createdAt"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS model_versions_org_registry_uq
      ON model_versions ("organizationId", "registryUri")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS model_versions_org_registry_uq`);
    await queryRunner.query(`DROP INDEX IF EXISTS models_org_provider_vendor_uq`);
  }
}
