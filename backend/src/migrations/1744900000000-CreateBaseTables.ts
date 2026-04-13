import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBaseTables1744900000000 implements MigrationInterface {
  name = 'CreateBaseTables1744900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure uuid-ossp extension exists
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ──────────────────────────────────────────────
    // 1. users
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying NOT NULL,
        "passwordHash" character varying NOT NULL,
        "firstName" character varying NOT NULL,
        "lastName" character varying NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "isVerified" boolean NOT NULL DEFAULT false,
        "verificationToken" character varying,
        "resetPasswordToken" character varying,
        "resetPasswordExpires" TIMESTAMP,
        "lastLoginAt" TIMESTAMP,
        "preferences" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email")`,
    );

    // ──────────────────────────────────────────────
    // 2. organizations
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "organizations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "slug" character varying NOT NULL,
        "description" character varying,
        "website" character varying,
        "logo" character varying,
        "isActive" boolean NOT NULL DEFAULT true,
        "settings" json,
        "agentDefaults" json,
        "billingInfo" json,
        "plan" character varying NOT NULL DEFAULT 'free',
        "planExpiresAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organizations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_organizations_name" UNIQUE ("name"),
        CONSTRAINT "UQ_organizations_slug" UNIQUE ("slug")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_organizations_name" ON "organizations" ("name")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_organizations_slug" ON "organizations" ("slug")`,
    );

    // ──────────────────────────────────────────────
    // 3. user_organizations
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_organizations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "role" character varying NOT NULL DEFAULT 'member',
        "isActive" boolean NOT NULL DEFAULT true,
        "invitedBy" character varying,
        "inviteToken" character varying,
        "inviteExpiresAt" TIMESTAMP,
        "inviteAccepted" boolean NOT NULL DEFAULT false,
        "permissions" json,
        "joinedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_organizations" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_organizations_userId_organizationId" ON "user_organizations" ("userId", "organizationId")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_user_organizations_userId') THEN
          ALTER TABLE "user_organizations"
          ADD CONSTRAINT "FK_user_organizations_userId"
          FOREIGN KEY ("userId") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_user_organizations_organizationId') THEN
          ALTER TABLE "user_organizations"
          ADD CONSTRAINT "FK_user_organizations_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 4. teams
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "teams" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "organizationId" uuid NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "settings" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_teams" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_teams_organizationId') THEN
          ALTER TABLE "teams"
          ADD CONSTRAINT "FK_teams_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 5. user_teams
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_teams" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "teamId" uuid NOT NULL,
        "role" character varying NOT NULL DEFAULT 'member',
        "isActive" boolean NOT NULL DEFAULT true,
        "joinedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_teams" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_teams_userId_teamId" ON "user_teams" ("userId", "teamId")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_user_teams_userId') THEN
          ALTER TABLE "user_teams"
          ADD CONSTRAINT "FK_user_teams_userId"
          FOREIGN KEY ("userId") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_user_teams_teamId') THEN
          ALTER TABLE "user_teams"
          ADD CONSTRAINT "FK_user_teams_teamId"
          FOREIGN KEY ("teamId") REFERENCES "teams"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 6. apis
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "apis" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "baseUrl" character varying NOT NULL,
        "version" character varying NOT NULL DEFAULT '1.0.0',
        "type" character varying NOT NULL DEFAULT 'other',
        "status" character varying NOT NULL DEFAULT 'draft',
        "organizationId" uuid NOT NULL,
        "headers" json,
        "authentication" json,
        "rateLimits" json,
        "metadata" json,
        "timeoutMs" integer NOT NULL DEFAULT 30000,
        "retryAttempts" integer NOT NULL DEFAULT 3,
        "dependencies" jsonb,
        "npmRegistry" jsonb,
        "sdkMaps" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_apis" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_apis_organizationId_name" ON "apis" ("organizationId", "name")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_apis_organizationId') THEN
          ALTER TABLE "apis"
          ADD CONSTRAINT "FK_apis_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 7. api_schemas
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_schemas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "apiId" uuid NOT NULL,
        "rawSchema" text NOT NULL,
        "processedSchema" json NOT NULL,
        "schemaHash" character varying NOT NULL,
        "version" character varying NOT NULL DEFAULT '1.0.0',
        "format" character varying NOT NULL DEFAULT 'json',
        "fileName" character varying,
        "fileSize" integer,
        "validationResults" json,
        "statistics" json,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_schemas" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_api_schemas_apiId" ON "api_schemas" ("apiId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_api_schemas_apiId_version" ON "api_schemas" ("apiId", "version")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_api_schemas_apiId') THEN
          ALTER TABLE "api_schemas"
          ADD CONSTRAINT "FK_api_schemas_apiId"
          FOREIGN KEY ("apiId") REFERENCES "apis"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 8. json_schemas
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "json_schemas" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "schema" json NOT NULL,
        "schemaHash" character varying NOT NULL,
        "description" character varying,
        "type" character varying NOT NULL DEFAULT 'parameter',
        "sourceSchemaId" uuid,
        "version" character varying NOT NULL DEFAULT '1.0.0',
        "examples" json,
        "validationRules" json,
        "metadata" json,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_json_schemas" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_json_schemas_sourceSchemaId') THEN
          ALTER TABLE "json_schemas"
          ADD CONSTRAINT "FK_json_schemas_sourceSchemaId"
          FOREIGN KEY ("sourceSchemaId") REFERENCES "api_schemas"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 9. resources
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "resources" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "apiId" uuid NOT NULL,
        "type" character varying NOT NULL DEFAULT 'model',
        "properties" json,
        "schema" json,
        "examples" json,
        "validationRules" json,
        "relationships" json,
        "metadata" json,
        "isActive" boolean NOT NULL DEFAULT true,
        "deprecated" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resources" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_resources_apiId" ON "resources" ("apiId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_resources_apiId_type" ON "resources" ("apiId", "type")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_resources_apiId') THEN
          ALTER TABLE "resources"
          ADD CONSTRAINT "FK_resources_apiId"
          FOREIGN KEY ("apiId") REFERENCES "apis"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 10. operations
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "operations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "operationId" character varying,
        "description" character varying,
        "apiId" uuid NOT NULL,
        "resourceId" uuid,
        "method" character varying,
        "endpoint" character varying NOT NULL,
        "type" character varying NOT NULL DEFAULT 'query',
        "parameters" json,
        "responses" json,
        "security" json,
        "tags" json,
        "isActive" boolean NOT NULL DEFAULT true,
        "deprecated" boolean NOT NULL DEFAULT false,
        "deprecationMessage" character varying,
        "rateLimit" json,
        "timeoutMs" integer NOT NULL DEFAULT 30000,
        "retryConfig" json,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_operations" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_operations_apiId" ON "operations" ("apiId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_operations_apiId_isActive" ON "operations" ("apiId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_operations_apiId_deprecated" ON "operations" ("apiId", "deprecated")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_operations_apiId') THEN
          ALTER TABLE "operations"
          ADD CONSTRAINT "FK_operations_apiId"
          FOREIGN KEY ("apiId") REFERENCES "apis"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_operations_resourceId') THEN
          ALTER TABLE "operations"
          ADD CONSTRAINT "FK_operations_resourceId"
          FOREIGN KEY ("resourceId") REFERENCES "resources"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 11. credentials
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "credentials" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "apiId" uuid,
        "organizationId" uuid NOT NULL,
        "type" character varying NOT NULL DEFAULT 'api_key',
        "config" json NOT NULL,
        "keyName" character varying,
        "keyLocation" character varying,
        "isActive" boolean NOT NULL DEFAULT true,
        "expiresAt" TIMESTAMP,
        "lastUsedAt" TIMESTAMP,
        "scopes" json,
        "metadata" json,
        "usedBy" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credentials" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_credentials_apiId') THEN
          ALTER TABLE "credentials"
          ADD CONSTRAINT "FK_credentials_apiId"
          FOREIGN KEY ("apiId") REFERENCES "apis"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_credentials_organizationId') THEN
          ALTER TABLE "credentials"
          ADD CONSTRAINT "FK_credentials_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 12. tools
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tools" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "type" character varying NOT NULL DEFAULT 'function',
        "code" text,
        "executionMethod" character varying,
        "authConfig" json,
        "status" character varying NOT NULL DEFAULT 'draft',
        "version" character varying NOT NULL DEFAULT '1.0.0',
        "operationId" uuid,
        "apiId" uuid,
        "organizationId" uuid NOT NULL,
        "inputSchemaId" uuid,
        "outputSchemaId" uuid,
        "parameters" json,
        "examples" json,
        "configuration" json,
        "metadata" json,
        "llmConfig" json,
        "httpConfig" json,
        "graphqlConfig" json,
        "soapConfig" json,
        "grpcConfig" json,
        "dependencies" jsonb,
        "npmRegistry" jsonb,
        "sdkConfig" jsonb,
        "isSystemTool" boolean NOT NULL DEFAULT false,
        "definitionHash" character varying(64),
        "usageCount" integer NOT NULL DEFAULT 0,
        "lastUsedAt" TIMESTAMP,
        "successRate" integer NOT NULL DEFAULT 0,
        "averageResponseTime" integer NOT NULL DEFAULT 0,
        "createdBy" character varying,
        "updatedBy" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tools" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tools_name_operationId" ON "tools" ("name", "operationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tools_organizationId_name" ON "tools" ("organizationId", "name")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tools_organizationId_status" ON "tools" ("organizationId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tools_organizationId_createdAt" ON "tools" ("organizationId", "createdAt")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tools_operationId') THEN
          ALTER TABLE "tools"
          ADD CONSTRAINT "FK_tools_operationId"
          FOREIGN KEY ("operationId") REFERENCES "operations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tools_apiId') THEN
          ALTER TABLE "tools"
          ADD CONSTRAINT "FK_tools_apiId"
          FOREIGN KEY ("apiId") REFERENCES "apis"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tools_organizationId') THEN
          ALTER TABLE "tools"
          ADD CONSTRAINT "FK_tools_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tools_inputSchemaId') THEN
          ALTER TABLE "tools"
          ADD CONSTRAINT "FK_tools_inputSchemaId"
          FOREIGN KEY ("inputSchemaId") REFERENCES "json_schemas"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tools_outputSchemaId') THEN
          ALTER TABLE "tools"
          ADD CONSTRAINT "FK_tools_outputSchemaId"
          FOREIGN KEY ("outputSchemaId") REFERENCES "json_schemas"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 13. tool_versions
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "toolId" uuid NOT NULL,
        "version" character varying NOT NULL,
        "definition" json NOT NULL,
        "parameters" json,
        "changelog" text,
        "metadata" json,
        "isBreakingChange" boolean NOT NULL DEFAULT false,
        "createdBy" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tool_versions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_versions_toolId') THEN
          ALTER TABLE "tool_versions"
          ADD CONSTRAINT "FK_tool_versions_toolId"
          FOREIGN KEY ("toolId") REFERENCES "tools"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 14. tool_categories (closure-table tree)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_categories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "slug" character varying NOT NULL,
        "organizationId" uuid NOT NULL,
        "icon" character varying,
        "color" character varying,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "parentId" uuid,
        CONSTRAINT "PK_tool_categories" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tool_categories_slug" UNIQUE ("slug")
      )
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_categories_parentId') THEN
          ALTER TABLE "tool_categories"
          ADD CONSTRAINT "FK_tool_categories_parentId"
          FOREIGN KEY ("parentId") REFERENCES "tool_categories"("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // TypeORM closure-table support table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_categories_closure" (
        "id_ancestor" uuid NOT NULL,
        "id_descendant" uuid NOT NULL,
        CONSTRAINT "PK_tool_categories_closure" PRIMARY KEY ("id_ancestor", "id_descendant")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_categories_closure_ancestor" ON "tool_categories_closure" ("id_ancestor")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_categories_closure_descendant" ON "tool_categories_closure" ("id_descendant")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_categories_closure_ancestor') THEN
          ALTER TABLE "tool_categories_closure"
          ADD CONSTRAINT "FK_tool_categories_closure_ancestor"
          FOREIGN KEY ("id_ancestor") REFERENCES "tool_categories"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_categories_closure_descendant') THEN
          ALTER TABLE "tool_categories_closure"
          ADD CONSTRAINT "FK_tool_categories_closure_descendant"
          FOREIGN KEY ("id_descendant") REFERENCES "tool_categories"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ManyToMany join table: tools <-> tool_categories
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_categories_mapping" (
        "toolId" uuid NOT NULL,
        "categoryId" uuid NOT NULL,
        CONSTRAINT "PK_tool_categories_mapping" PRIMARY KEY ("toolId", "categoryId")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_categories_mapping_toolId" ON "tool_categories_mapping" ("toolId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_categories_mapping_categoryId" ON "tool_categories_mapping" ("categoryId")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_categories_mapping_toolId') THEN
          ALTER TABLE "tool_categories_mapping"
          ADD CONSTRAINT "FK_tool_categories_mapping_toolId"
          FOREIGN KEY ("toolId") REFERENCES "tools"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_categories_mapping_categoryId') THEN
          ALTER TABLE "tool_categories_mapping"
          ADD CONSTRAINT "FK_tool_categories_mapping_categoryId"
          FOREIGN KEY ("categoryId") REFERENCES "tool_categories"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 15. tool_executions
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_executions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "toolId" uuid NOT NULL,
        "userId" uuid,
        "organizationId" uuid NOT NULL,
        "gatewayId" uuid,
        "parameters" json NOT NULL,
        "result" json,
        "success" boolean NOT NULL,
        "error" text,
        "executionTime" integer NOT NULL DEFAULT 0,
        "cached" boolean NOT NULL DEFAULT false,
        "retryCount" integer NOT NULL DEFAULT 0,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tool_executions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_executions_toolId" ON "tool_executions" ("toolId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_executions_userId" ON "tool_executions" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_executions_organizationId" ON "tool_executions" ("organizationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_executions_gatewayId" ON "tool_executions" ("gatewayId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_executions_success" ON "tool_executions" ("success")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_executions_toolId_organizationId_createdAt" ON "tool_executions" ("toolId", "organizationId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_executions_userId_createdAt" ON "tool_executions" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tool_executions_success_createdAt" ON "tool_executions" ("success", "createdAt")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_executions_toolId') THEN
          ALTER TABLE "tool_executions"
          ADD CONSTRAINT "FK_tool_executions_toolId"
          FOREIGN KEY ("toolId") REFERENCES "tools"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_executions_userId') THEN
          ALTER TABLE "tool_executions"
          ADD CONSTRAINT "FK_tool_executions_userId"
          FOREIGN KEY ("userId") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_tool_executions_organizationId') THEN
          ALTER TABLE "tool_executions"
          ADD CONSTRAINT "FK_tool_executions_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 16. gateways
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "gateways" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "kind" character varying NOT NULL DEFAULT 'tool',
        "type" character varying NOT NULL,
        "agentId" uuid,
        "status" character varying NOT NULL DEFAULT 'active',
        "organizationId" uuid NOT NULL,
        "endpoint" character varying NOT NULL,
        "configuration" json NOT NULL,
        "rateLimitConfig" json,
        "corsConfig" json,
        "webhooks" json,
        "requestTimeout" integer NOT NULL DEFAULT 30000,
        "maxRetries" integer NOT NULL DEFAULT 3,
        "customHeaders" json,
        "healthCheck" json,
        "metadata" json,
        "totalRequests" integer NOT NULL DEFAULT 0,
        "successfulRequests" integer NOT NULL DEFAULT 0,
        "lastRequestAt" TIMESTAMP,
        "lastHealthCheckAt" TIMESTAMP,
        "isHealthy" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gateways" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_gateways_organizationId_name" ON "gateways" ("organizationId", "name")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_gateways_organizationId_endpoint" ON "gateways" ("organizationId", "endpoint")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_gateways_organizationId') THEN
          ALTER TABLE "gateways"
          ADD CONSTRAINT "FK_gateways_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // agentId FK: the agents table is created by an earlier migration
    // (1741900000000), but we guard with DO $$ anyway for safety.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_gateways_agentId') THEN
          ALTER TABLE "gateways"
          ADD CONSTRAINT "FK_gateways_agentId"
          FOREIGN KEY ("agentId") REFERENCES "agents"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 17. gateway_tools
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "gateway_tools" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "gatewayId" uuid NOT NULL,
        "toolId" uuid NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "overrides" json,
        "permissions" json,
        "transformations" json,
        "usageCount" integer NOT NULL DEFAULT 0,
        "lastUsedAt" TIMESTAMP,
        "securityPolicy" json,
        "metadata" json,
        "associatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gateway_tools" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_gateway_tools_gatewayId_toolId" ON "gateway_tools" ("gatewayId", "toolId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_gateway_tools_toolId_isActive" ON "gateway_tools" ("toolId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_gateway_tools_gatewayId_isActive" ON "gateway_tools" ("gatewayId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_gateway_tools_gatewayId_usageCount" ON "gateway_tools" ("gatewayId", "usageCount")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_gateway_tools_gatewayId') THEN
          ALTER TABLE "gateway_tools"
          ADD CONSTRAINT "FK_gateway_tools_gatewayId"
          FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_gateway_tools_toolId') THEN
          ALTER TABLE "gateway_tools"
          ADD CONSTRAINT "FK_gateway_tools_toolId"
          FOREIGN KEY ("toolId") REFERENCES "tools"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 18. gateway_auth
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "gateway_auth" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "gatewayId" uuid NOT NULL,
        "type" character varying NOT NULL DEFAULT 'api_key',
        "isRequired" boolean NOT NULL DEFAULT true,
        "isActive" boolean NOT NULL DEFAULT true,
        "configuration" json NOT NULL,
        "validationRules" json,
        "errorResponses" json,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_gateway_auth" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_gateway_auth_gatewayId') THEN
          ALTER TABLE "gateway_auth"
          ADD CONSTRAINT "FK_gateway_auth_gatewayId"
          FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 19. llm_providers
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_providers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "type" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'active',
        "organizationId" uuid NOT NULL,
        "credentialId" uuid,
        "configuration" json NOT NULL,
        "capabilities" json,
        "metadata" json,
        "totalRequests" integer NOT NULL DEFAULT 0,
        "successfulRequests" integer NOT NULL DEFAULT 0,
        "totalTokensUsed" integer NOT NULL DEFAULT 0,
        "totalCost" double precision NOT NULL DEFAULT 0,
        "lastRequestAt" TIMESTAMP,
        "lastHealthCheckAt" TIMESTAMP,
        "isHealthy" boolean NOT NULL DEFAULT true,
        "lastError" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_llm_providers" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_llm_providers_organizationId_name" ON "llm_providers" ("organizationId", "name")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_llm_providers_type_status" ON "llm_providers" ("type", "status")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_llm_providers_organizationId') THEN
          ALTER TABLE "llm_providers"
          ADD CONSTRAINT "FK_llm_providers_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_llm_providers_credentialId') THEN
          ALTER TABLE "llm_providers"
          ADD CONSTRAINT "FK_llm_providers_credentialId"
          FOREIGN KEY ("credentialId") REFERENCES "credentials"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 20. api_keys
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_keys" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "keyHash" character varying NOT NULL,
        "keyPrefix" character varying NOT NULL,
        "userId" uuid NOT NULL,
        "organizationId" uuid,
        "gatewayId" uuid,
        "agentId" uuid,
        "isActive" boolean NOT NULL DEFAULT true,
        "expiresAt" TIMESTAMP,
        "lastUsedAt" TIMESTAMP,
        "scopes" json,
        "rateLimits" json,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_keys" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_api_keys_keyHash" UNIQUE ("keyHash")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_api_keys_keyHash" ON "api_keys" ("keyHash")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_api_keys_userId') THEN
          ALTER TABLE "api_keys"
          ADD CONSTRAINT "FK_api_keys_userId"
          FOREIGN KEY ("userId") REFERENCES "users"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_api_keys_organizationId') THEN
          ALTER TABLE "api_keys"
          ADD CONSTRAINT "FK_api_keys_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_api_keys_gatewayId') THEN
          ALTER TABLE "api_keys"
          ADD CONSTRAINT "FK_api_keys_gatewayId"
          FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 21. usage_metrics
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "usage_metrics" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" character varying NOT NULL,
        "value" numeric(15,4) NOT NULL,
        "status" character varying NOT NULL DEFAULT 'success',
        "gatewayId" uuid,
        "toolId" uuid,
        "userId" uuid,
        "organizationId" uuid,
        "llmProviderId" uuid,
        "dimensions" json,
        "metadata" json,
        "timestamp" TIMESTAMP NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_usage_metrics" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_usage_metrics_timestamp_type" ON "usage_metrics" ("timestamp", "type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_usage_metrics_gatewayId_timestamp" ON "usage_metrics" ("gatewayId", "timestamp")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_usage_metrics_organizationId_timestamp" ON "usage_metrics" ("organizationId", "timestamp")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_usage_metrics_gatewayId') THEN
          ALTER TABLE "usage_metrics"
          ADD CONSTRAINT "FK_usage_metrics_gatewayId"
          FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_usage_metrics_toolId') THEN
          ALTER TABLE "usage_metrics"
          ADD CONSTRAINT "FK_usage_metrics_toolId"
          FOREIGN KEY ("toolId") REFERENCES "tools"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_usage_metrics_userId') THEN
          ALTER TABLE "usage_metrics"
          ADD CONSTRAINT "FK_usage_metrics_userId"
          FOREIGN KEY ("userId") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_usage_metrics_organizationId') THEN
          ALTER TABLE "usage_metrics"
          ADD CONSTRAINT "FK_usage_metrics_organizationId"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_usage_metrics_llmProviderId') THEN
          ALTER TABLE "usage_metrics"
          ADD CONSTRAINT "FK_usage_metrics_llmProviderId"
          FOREIGN KEY ("llmProviderId") REFERENCES "llm_providers"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    // ──────────────────────────────────────────────
    // 22. request_logs
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "request_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "method" character varying NOT NULL,
        "path" character varying NOT NULL,
        "userAgent" character varying,
        "ipAddress" character varying,
        "statusCode" integer NOT NULL,
        "responseTime" integer NOT NULL,
        "gatewayId" uuid,
        "toolId" uuid,
        "userId" uuid,
        "requestHeaders" json,
        "responseHeaders" json,
        "requestBody" text,
        "responseBody" text,
        "errorMessage" character varying,
        "requestId" character varying,
        "requestSize" integer NOT NULL DEFAULT 0,
        "responseSize" integer NOT NULL DEFAULT 0,
        "metadata" json,
        "timestamp" TIMESTAMP NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_request_logs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_request_logs_timestamp" ON "request_logs" ("timestamp")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_request_logs_gatewayId_timestamp" ON "request_logs" ("gatewayId", "timestamp")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_request_logs_statusCode" ON "request_logs" ("statusCode")`,
    );

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_request_logs_gatewayId') THEN
          ALTER TABLE "request_logs"
          ADD CONSTRAINT "FK_request_logs_gatewayId"
          FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_request_logs_toolId') THEN
          ALTER TABLE "request_logs"
          ADD CONSTRAINT "FK_request_logs_toolId"
          FOREIGN KEY ("toolId") REFERENCES "tools"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_request_logs_userId') THEN
          ALTER TABLE "request_logs"
          ADD CONSTRAINT "FK_request_logs_userId"
          FOREIGN KEY ("userId") REFERENCES "users"("id")
          ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No-op: these tables contain production data and were originally
    // created by TypeORM synchronize. Dropping them in a rollback would
    // cause irreversible data loss. If you truly need to undo this
    // migration on a fresh database, drop the tables manually.
  }
}
