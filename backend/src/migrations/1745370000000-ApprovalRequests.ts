import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3: HITL approval workflow.
 *
 * Adds approval_requests + waiting_approval state on agent_runs.
 * (Run state is enum-string, no DB migration needed beyond the
 * entity-side enum addition.)
 */
export class ApprovalRequests1745370000000 implements MigrationInterface {
  name = 'ApprovalRequests1745370000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS approval_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "teamId" UUID,
        visibility VARCHAR(8) NOT NULL DEFAULT 'org',
        "runId" UUID NOT NULL,
        "agentId" UUID NOT NULL,
        "toolCallId" VARCHAR(255),
        reason TEXT NOT NULL,
        payload JSONB,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        "decidedBy" UUID,
        "decidedAt" TIMESTAMPTZ,
        "decisionReason" TEXT,
        "expiresAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX approval_requests_org_status_idx ON approval_requests ("organizationId", status, "createdAt" DESC)`);
    await queryRunner.query(`CREATE INDEX approval_requests_run_idx ON approval_requests ("runId")`);
    await queryRunner.query(`CREATE INDEX approval_requests_team_idx ON approval_requests ("teamId") WHERE "teamId" IS NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_visibility_team_chk CHECK (
        (visibility = 'team' AND "teamId" IS NOT NULL) OR
        (visibility = 'org'  AND "teamId" IS NULL)
      )
    `);
    // FKs: cascade-delete the request if its run/agent disappears.
    await queryRunner.query(`
      ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_run_fk
      FOREIGN KEY ("runId") REFERENCES agent_runs (id) ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_agent_fk
      FOREIGN KEY ("agentId") REFERENCES agents (id) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS approval_requests CASCADE`);
  }
}
