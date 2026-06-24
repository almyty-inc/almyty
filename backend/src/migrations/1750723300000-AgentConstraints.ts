import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AgentConstraint: per-agent failure-memory rules injected into the system
 * prompt (the "learn from failure" complement to promoted skills).
 */
export class AgentConstraints1750723300000 implements MigrationInterface {
  name = 'AgentConstraints1750723300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agent_constraints (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "agentId" UUID NOT NULL,
        rule TEXT NOT NULL,
        "sourceRunId" UUID,
        active BOOLEAN NOT NULL DEFAULT true,
        origin VARCHAR(16) NOT NULL DEFAULT 'manual',
        "createdBy" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX agent_constraints_org_agent_idx ON agent_constraints ("organizationId", "agentId")`);
    await queryRunner.query(`
      ALTER TABLE agent_constraints
      ADD CONSTRAINT agent_constraints_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE agent_constraints
      ADD CONSTRAINT agent_constraints_agent_fk
      FOREIGN KEY ("agentId") REFERENCES agents (id) ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE agent_constraints
      ADD CONSTRAINT agent_constraints_run_fk
      FOREIGN KEY ("sourceRunId") REFERENCES agent_runs (id) ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS agent_constraints CASCADE`);
  }
}
