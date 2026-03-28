import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRuntimeMemoryInterfacesFiles1743120000000 implements MigrationInterface {
  name = 'AddRuntimeMemoryInterfacesFiles1743120000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create agent_runs table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "agentId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "userId" character varying,
        "mode" character varying NOT NULL DEFAULT 'workflow',
        "status" character varying NOT NULL DEFAULT 'pending',
        "thread" json NOT NULL DEFAULT '[]',
        "workingMemory" json NOT NULL DEFAULT '{}',
        "steps" json NOT NULL DEFAULT '[]',
        "currentStep" integer NOT NULL DEFAULT 0,
        "maxSteps" integer NOT NULL DEFAULT 50,
        "input" json,
        "output" json,
        "error" text,
        "totalCost" double precision NOT NULL DEFAULT 0,
        "totalTokens" integer NOT NULL DEFAULT 0,
        "executionTime" integer NOT NULL DEFAULT 0,
        "metadata" json,
        "limits" json,
        "parentRunId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_runs" PRIMARY KEY ("id")
      )
    `);

    // Add foreign keys on agent_runs
    await queryRunner.query(`
      ALTER TABLE "agent_runs"
      ADD CONSTRAINT "FK_agent_runs_agentId"
      FOREIGN KEY ("agentId") REFERENCES "agents"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      ALTER TABLE "agent_runs"
      ADD CONSTRAINT "FK_agent_runs_organizationId"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // Add indexes on agent_runs
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_runs_agentId_createdAt" ON "agent_runs" ("agentId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_runs_organizationId_createdAt" ON "agent_runs" ("organizationId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_runs_status" ON "agent_runs" ("status")`,
    );

    // Add columns to agents table
    await queryRunner.query(`
      ALTER TABLE "agents"
      ADD COLUMN IF NOT EXISTS "mode" character varying NOT NULL DEFAULT 'workflow',
      ADD COLUMN IF NOT EXISTS "instructions" text,
      ADD COLUMN IF NOT EXISTS "toolIds" uuid[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS "modelConfig" json,
      ADD COLUMN IF NOT EXISTS "memoryConfig" json
    `);

    // Create memories table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "memories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "type" character varying NOT NULL,
        "content" text NOT NULL,
        "embedding" float8[],
        "source" json,
        "scope" character varying NOT NULL DEFAULT 'shared',
        "agentIds" uuid[] NOT NULL DEFAULT '{}',
        "tags" text[] NOT NULL DEFAULT '{}',
        "metadata" json,
        "isActive" boolean NOT NULL DEFAULT true,
        "accessCount" integer NOT NULL DEFAULT 0,
        "lastAccessedAt" TIMESTAMP,
        "createdBy" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_memories" PRIMARY KEY ("id")
      )
    `);

    // Add foreign key on memories
    await queryRunner.query(`
      ALTER TABLE "memories"
      ADD CONSTRAINT "FK_memories_organizationId"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // Add indexes on memories
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_memories_organizationId_scope" ON "memories" ("organizationId", "scope")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_memories_organizationId_type" ON "memories" ("organizationId", "type")`,
    );

    // Create interfaces table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "interfaces" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "agentId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "type" character varying NOT NULL,
        "name" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'inactive',
        "configuration" json NOT NULL DEFAULT '{}',
        "metadata" json,
        "totalMessages" integer NOT NULL DEFAULT 0,
        "lastMessageAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_interfaces" PRIMARY KEY ("id")
      )
    `);

    // Add foreign keys on interfaces
    await queryRunner.query(`
      ALTER TABLE "interfaces"
      ADD CONSTRAINT "FK_interfaces_agentId"
      FOREIGN KEY ("agentId") REFERENCES "agents"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      ALTER TABLE "interfaces"
      ADD CONSTRAINT "FK_interfaces_organizationId"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // Add indexes on interfaces
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_interfaces_agentId" ON "interfaces" ("agentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_interfaces_organizationId" ON "interfaces" ("organizationId")`,
    );

    // Create files table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "files" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "agentId" uuid,
        "runId" uuid,
        "name" character varying NOT NULL,
        "mimeType" character varying NOT NULL,
        "size" integer NOT NULL DEFAULT 0,
        "storageKey" character varying NOT NULL,
        "storageUrl" character varying,
        "extractedText" text,
        "memoryId" uuid,
        "uploadedBy" character varying,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_files" PRIMARY KEY ("id")
      )
    `);

    // Add foreign key on files
    await queryRunner.query(`
      ALTER TABLE "files"
      ADD CONSTRAINT "FK_files_organizationId"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // Add indexes on files
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_files_organizationId" ON "files" ("organizationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_files_agentId" ON "files" ("agentId")`,
    );

    // Create audit_logs table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "userId" character varying,
        "userEmail" character varying,
        "action" character varying NOT NULL,
        "resourceType" character varying NOT NULL,
        "resourceId" character varying NOT NULL,
        "resourceName" character varying,
        "details" json,
        "changes" json,
        "ipAddress" character varying,
        "userAgent" character varying,
        "status" character varying,
        "duration" double precision,
        "cost" double precision,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id")
      )
    `);

    // Add foreign key on audit_logs
    await queryRunner.query(`
      ALTER TABLE "audit_logs"
      ADD CONSTRAINT "FK_audit_logs_organizationId"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // Add indexes on audit_logs
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_organizationId_createdAt" ON "audit_logs" ("organizationId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_resourceType_resourceId" ON "audit_logs" ("resourceType", "resourceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_userId_createdAt" ON "audit_logs" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON "audit_logs" ("action")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop audit_logs
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_action"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_userId_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_resourceType_resourceId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_organizationId_createdAt"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "FK_audit_logs_organizationId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);

    // Drop files
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_files_agentId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_files_organizationId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "FK_files_organizationId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "files"`);

    // Drop interfaces
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_interfaces_organizationId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_interfaces_agentId"`);
    await queryRunner.query(`ALTER TABLE "interfaces" DROP CONSTRAINT IF EXISTS "FK_interfaces_organizationId"`);
    await queryRunner.query(`ALTER TABLE "interfaces" DROP CONSTRAINT IF EXISTS "FK_interfaces_agentId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "interfaces"`);

    // Drop memories
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_memories_organizationId_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_memories_organizationId_scope"`);
    await queryRunner.query(`ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "FK_memories_organizationId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "memories"`);

    // Drop agent_runs
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_runs_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_runs_organizationId_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_runs_agentId_createdAt"`);
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "FK_agent_runs_organizationId"`);
    await queryRunner.query(`ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "FK_agent_runs_agentId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_runs"`);

    // Remove columns from agents table
    await queryRunner.query(`
      ALTER TABLE "agents"
      DROP COLUMN IF EXISTS "memoryConfig",
      DROP COLUMN IF EXISTS "modelConfig",
      DROP COLUMN IF EXISTS "toolIds",
      DROP COLUMN IF EXISTS "instructions",
      DROP COLUMN IF EXISTS "mode"
    `);
  }
}
