import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cost governance (P2): cross-run spend budgets + append-only breach
 * alerts. `spend_budgets` holds the per-period ceiling on the user's
 * own LLM spend; `spend_alerts` logs each soft/hard breach once per
 * period (enforced by the unique dedup index).
 */
export class SpendGovernance1750723400000 implements MigrationInterface {
  name = 'SpendGovernance1750723400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS spend_budgets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "agentId" UUID,
        "llmProviderId" UUID,
        "periodType" VARCHAR NOT NULL DEFAULT 'month',
        "limitCents" INTEGER NOT NULL,
        "behavior" VARCHAR NOT NULL DEFAULT 'warn_log',
        "softThresholdPct" INTEGER NOT NULL DEFAULT 80,
        "active" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX spend_budgets_org_agent_idx ON spend_budgets ("organizationId", "agentId")`,
    );
    await queryRunner.query(`
      ALTER TABLE spend_budgets
      ADD CONSTRAINT spend_budgets_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS spend_alerts (
        id BIGSERIAL PRIMARY KEY,
        "budgetId" UUID NOT NULL,
        "organizationId" UUID NOT NULL,
        "agentId" UUID,
        "llmProviderId" UUID,
        "level" VARCHAR NOT NULL,
        "periodType" VARCHAR NOT NULL,
        period_start TIMESTAMPTZ NOT NULL,
        "spentCents" INTEGER NOT NULL,
        "limitCents" INTEGER NOT NULL,
        "at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX spend_alerts_org_idx ON spend_alerts ("organizationId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX spend_alerts_dedup ON spend_alerts ("budgetId", period_start, "level")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS spend_alerts CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS spend_budgets CASCADE`);
  }
}
