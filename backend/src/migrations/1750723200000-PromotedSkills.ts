import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PromotedSkill: reusable skills distilled from successful agent runs
 * (the "promote" step of run -> verify -> promote -> replay).
 */
export class PromotedSkills1750723200000 implements MigrationInterface {
  name = 'PromotedSkills1750723200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS promoted_skills (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organizationId" UUID NOT NULL,
        "agentId" UUID,
        "sourceRunId" UUID,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        description TEXT,
        content TEXT NOT NULL,
        frontmatter JSONB,
        "inputExample" JSONB,
        version INTEGER NOT NULL DEFAULT 1,
        "createdBy" UUID,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`CREATE INDEX promoted_skills_org_created_idx ON promoted_skills ("organizationId", "createdAt" DESC)`);
    await queryRunner.query(`CREATE UNIQUE INDEX promoted_skills_org_slug_idx ON promoted_skills ("organizationId", slug)`);
    // Org delete cascades the skill; agent/run deletes keep the skill (provenance nulled).
    await queryRunner.query(`
      ALTER TABLE promoted_skills
      ADD CONSTRAINT promoted_skills_org_fk
      FOREIGN KEY ("organizationId") REFERENCES organizations (id) ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE promoted_skills
      ADD CONSTRAINT promoted_skills_agent_fk
      FOREIGN KEY ("agentId") REFERENCES agents (id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE promoted_skills
      ADD CONSTRAINT promoted_skills_run_fk
      FOREIGN KEY ("sourceRunId") REFERENCES agent_runs (id) ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS promoted_skills CASCADE`);
  }
}
