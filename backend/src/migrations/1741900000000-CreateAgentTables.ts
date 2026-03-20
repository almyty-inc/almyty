import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAgentTables1741900000000 implements MigrationInterface {
  name = 'CreateAgentTables1741900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create agents table
    await queryRunner.query(`
      CREATE TABLE "agents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "organizationId" uuid NOT NULL,
        "status" character varying NOT NULL DEFAULT 'draft',
        "version" character varying NOT NULL DEFAULT '1.0.0',
        "pipeline" json NOT NULL,
        "variables" json,
        "settings" json,
        "metadata" json,
        "totalExecutions" integer NOT NULL DEFAULT 0,
        "successfulExecutions" integer NOT NULL DEFAULT 0,
        "totalCost" double precision NOT NULL DEFAULT 0,
        "averageExecutionTime" integer NOT NULL DEFAULT 0,
        "lastExecutedAt" TIMESTAMP,
        "createdBy" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agents" PRIMARY KEY ("id")
      )
    `);

    // Create agent_executions table
    await queryRunner.query(`
      CREATE TABLE "agent_executions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "agentId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "userId" character varying,
        "status" character varying NOT NULL DEFAULT 'pending',
        "input" json,
        "output" json,
        "nodeResults" json,
        "executionTime" integer NOT NULL DEFAULT 0,
        "totalCost" double precision NOT NULL DEFAULT 0,
        "totalTokens" integer NOT NULL DEFAULT 0,
        "error" text,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_executions" PRIMARY KEY ("id")
      )
    `);

    // Add indexes on agents
    await queryRunner.query(
      `CREATE INDEX "IDX_agent_organizationId_name" ON "agents" ("organizationId", "name")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_agent_organizationId_status" ON "agents" ("organizationId", "status")`,
    );

    // Add indexes on agent_executions
    await queryRunner.query(
      `CREATE INDEX "IDX_agent_execution_agentId_createdAt" ON "agent_executions" ("agentId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_agent_execution_organizationId_createdAt" ON "agent_executions" ("organizationId", "createdAt")`,
    );

    // Add foreign keys
    await queryRunner.query(`
      ALTER TABLE "agents"
      ADD CONSTRAINT "FK_agents_organizationId"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      ALTER TABLE "agent_executions"
      ADD CONSTRAINT "FK_agent_executions_agentId"
      FOREIGN KEY ("agentId") REFERENCES "agents"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      ALTER TABLE "agent_executions"
      ADD CONSTRAINT "FK_agent_executions_organizationId"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign keys
    await queryRunner.query(`ALTER TABLE "agent_executions" DROP CONSTRAINT "FK_agent_executions_organizationId"`);
    await queryRunner.query(`ALTER TABLE "agent_executions" DROP CONSTRAINT "FK_agent_executions_agentId"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP CONSTRAINT "FK_agents_organizationId"`);

    // Drop indexes
    await queryRunner.query(`DROP INDEX "IDX_agent_execution_organizationId_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_agent_execution_agentId_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_agent_organizationId_status"`);
    await queryRunner.query(`DROP INDEX "IDX_agent_organizationId_name"`);

    // Drop tables
    await queryRunner.query(`DROP TABLE "agent_executions"`);
    await queryRunner.query(`DROP TABLE "agents"`);
  }
}
