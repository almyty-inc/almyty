import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hosted-billing (P6) Stripe webhook idempotency ledger. Every processed event
 * id is recorded so Stripe's at-least-once delivery cannot double-apply a
 * subscription change. The org's plan/seats/entitlement token hang on the
 * existing `organizations.billingInfo` JSON column, so no schema change is
 * needed there.
 */
export class BillingEvents1750723750000 implements MigrationInterface {
  name = 'BillingEvents1750723750000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing_events (
        "eventId" VARCHAR PRIMARY KEY,
        "type" VARCHAR NOT NULL,
        "organizationId" UUID,
        "processedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX billing_events_org_idx ON billing_events ("organizationId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS billing_events CASCADE`);
  }
}
