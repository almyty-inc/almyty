import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give request logs an owner of their own, and let a deleted
 * organization take its usage metrics with it.
 *
 * `request_logs` is the highest-volume table in the schema and its only
 * link to a tenant was `gatewayId`, foreign-keyed ON DELETE SET NULL.
 * The retention sweep scoped request logs by looking up the org's
 * gateways, so deleting a gateway -- an ordinary action -- detached
 * every log it had ever written and put those rows permanently out of
 * reach of any retention policy. The logs are the organization's data,
 * not the gateway's, so they get an `organizationId` rather than being
 * deleted along with the gateway.
 *
 * The interceptor that writes these rows already resolves the
 * organization (it was recording it in `metadata.organizationId`), so
 * the backfill has two sources: the gateway for rows that still have
 * one, and that metadata key for rows whose gateway is already gone.
 *
 * `usage_metrics.organizationId` has the mirror-image problem with a
 * rarer trigger: it was ON DELETE SET NULL while the sweep filters on
 * that exact column, so deleting an organization stranded its metrics
 * the same way. Nothing wants an orphaned usage metric, so it cascades.
 */
export class RequestLogOrganization1750796000000 implements MigrationInterface {
  name = 'RequestLogOrganization1750796000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "request_logs"
      ADD COLUMN IF NOT EXISTS "organizationId" uuid
    `);

    // Rows that still have a gateway: the gateway is authoritative.
    await queryRunner.query(`
      UPDATE "request_logs" AS rl
      SET "organizationId" = g."organizationId"
      FROM "gateways" AS g
      WHERE rl."gatewayId" = g."id" AND rl."organizationId" IS NULL
    `);

    // Rows whose gateway is already gone: the interceptor stashed the
    // organization in metadata, which is the only remaining evidence.
    //
    // Joined to `organizations` rather than cast straight into the column.
    // Metadata is a free-text json blob, not a reference, and nothing ever
    // checked that the id in it still names a live organization -- while
    // the rows this half exists for are precisely the ones whose gateway
    // has gone, and the commonest reason for that is that the organization
    // was deleted, cascading the gateway away and nulling this row's
    // gatewayId. Copying that dead id in and then adding the foreign key
    // aborts the migration on exactly the deployment the key exists to
    // protect, and the deploy is fail-closed, so nothing rolls out. That
    // is the shape that took staging down once already.
    //
    // The join also keeps the comparison in text, which cannot raise:
    // uuid::text always succeeds, whereas text::uuid on a malformed value
    // is an error Postgres is free to evaluate before the shape test
    // beside it. Re-running is a no-op either way -- a row that found no
    // organization the first time finds none the second.
    await queryRunner.query(`
      UPDATE "request_logs" AS rl
      SET "organizationId" = o."id"
      FROM "organizations" AS o
      WHERE rl."organizationId" IS NULL
        AND o."id"::text = lower(rl."metadata" ->> 'organizationId')
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_request_logs_organizationId'
            AND conrelid = '"request_logs"'::regclass
        ) THEN
          ALTER TABLE "request_logs"
            ADD CONSTRAINT "FK_request_logs_organizationId"
            FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE;
        END IF;
      END $$
    `);

    // The sweep deletes by (organizationId, timestamp).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_request_logs_organizationId_timestamp"
      ON "request_logs" ("organizationId", "timestamp")
    `);

    // usage_metrics: SET NULL stranded the rows the sweep filters by.
    await queryRunner.query(`
      ALTER TABLE "usage_metrics"
      DROP CONSTRAINT IF EXISTS "FK_usage_metrics_organizationId"
    `);
    await queryRunner.query(`
      DELETE FROM "usage_metrics" WHERE "organizationId" IS NOT NULL AND "organizationId" NOT IN (
        SELECT "id" FROM "organizations"
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "usage_metrics"
        ADD CONSTRAINT "FK_usage_metrics_organizationId"
        FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usage_metrics"
      DROP CONSTRAINT IF EXISTS "FK_usage_metrics_organizationId"
    `);
    await queryRunner.query(`
      ALTER TABLE "usage_metrics"
        ADD CONSTRAINT "FK_usage_metrics_organizationId"
        FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_request_logs_organizationId_timestamp"`);
    await queryRunner.query(`
      ALTER TABLE "request_logs"
      DROP CONSTRAINT IF EXISTS "FK_request_logs_organizationId"
    `);
    await queryRunner.query(`ALTER TABLE "request_logs" DROP COLUMN IF EXISTS "organizationId"`);
  }
}
