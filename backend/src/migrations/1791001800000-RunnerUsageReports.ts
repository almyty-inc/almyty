import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `runner_usage_reports`: one row per (organization, resource class, hour)
 * of hosted runner minutes, written by the hourly usage report in `ee`
 * (entities/runner-usage-report.entity.ts). The unique index is what makes
 * a retry of the same hour a no-op; `meterIdentifier` is unique too,
 * because Stripe deduplicates meter events on it.
 */
export class RunnerUsageReports1791001800000 implements MigrationInterface {
  name = 'RunnerUsageReports1791001800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "runner_usage_reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "resourceClass" character varying(16) NOT NULL,
        "hourStart" TIMESTAMP WITH TIME ZONE NOT NULL,
        "minutes" double precision NOT NULL,
        "billableMinutes" integer NOT NULL,
        "destination" character varying(16) NOT NULL,
        "meterIdentifier" character varying(128) NOT NULL,
        "reportedAt" TIMESTAMP WITH TIME ZONE,
        "lastError" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_runner_usage_reports" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_runner_usage_reports_meter_identifier" UNIQUE ("meterIdentifier"),
        CONSTRAINT "CHK_runner_usage_reports_billable" CHECK ("billableMinutes" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_runner_usage_reports_org_class_hour" ON "runner_usage_reports" ("organizationId", "resourceClass", "hourStart")`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_runner_usage_reports_reported" ON "runner_usage_reports" ("reportedAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "runner_usage_reports"`);
  }
}
