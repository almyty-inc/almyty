import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `app_builds`: one row per attempt at producing a downloadable
 * artifact.
 *
 * Separate from the distribution rather than a field on it, because
 * builds accumulate. A customer ships three platforms, finds the
 * Windows one came out unsigned, and rebuilds; answering "which binary
 * is this person running" later needs the history rather than only the
 * most recent result.
 *
 * The artifact itself lives in object storage and expires; the row
 * outlives it, because knowing a build happened and what came out of it
 * stays useful after the file is gone.
 */
export class AppBuilds1750752000000 implements MigrationInterface {
  name = 'AppBuilds1750752000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_builds" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "appId" uuid NOT NULL,
        "target" character varying NOT NULL,
        "platform" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'queued',
        "version" character varying,
        "signed" boolean NOT NULL DEFAULT false,
        "artifactKey" character varying,
        "artifactBytes" bigint,
        "checksum" character varying,
        "error" text,
        "log" text,
        "requestedBy" character varying,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "artifactExpiresAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_builds" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_app_builds_app_created"
      ON "app_builds" ("appId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_app_builds_org_created"
      ON "app_builds" ("organizationId", "createdAt")
    `);
    // The sweep that deletes expired artifacts scans by status, so it
    // should not have to read every build ever made.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_app_builds_status"
      ON "app_builds" ("status")
    `);

    await queryRunner.query(`
      ALTER TABLE "app_builds"
      ADD CONSTRAINT "FK_app_builds_app"
      FOREIGN KEY ("appId") REFERENCES "agent_apps"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_builds" DROP CONSTRAINT IF EXISTS "FK_app_builds_app"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_app_builds_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_app_builds_org_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_app_builds_app_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "app_builds"`);
  }
}
