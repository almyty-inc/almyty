import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable uuid-ossp extension
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ──────────────────────────────────────────────
    // 1. organizations (no FKs)
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
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_organizations_name" ON "organizations" ("name")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_organizations_slug" ON "organizations" ("slug")`);

    // ──────────────────────────────────────────────
    // 2. users (no FKs)
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
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email")`);

    // ──────────────────────────────────────────────
    // 3. user_organizations (FKs: users, organizations)
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
        CONSTRAINT "PK_user_organizations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_organizations_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_organizations_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_organizations_userId_organizationId" ON "user_organizations" ("userId", "organizationId")`);

    // ──────────────────────────────────────────────
    // 4. teams (FK: organizations)
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
        CONSTRAINT "PK_teams" PRIMARY KEY ("id"),
        CONSTRAINT "FK_teams_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    // ──────────────────────────────────────────────
    // 5. user_teams (FKs: users, teams)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_teams" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "teamId" uuid NOT NULL,
        "role" character varying NOT NULL DEFAULT 'member',
        "isActive" boolean NOT NULL DEFAULT true,
        "joinedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_teams" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_teams_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_teams_teamId" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_teams_userId_teamId" ON "user_teams" ("userId", "teamId")`);

    // ──────────────────────────────────────────────
    // 6. apis (FK: organizations) — needed before credentials
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
        CONSTRAINT "PK_apis" PRIMARY KEY ("id"),
        CONSTRAINT "FK_apis_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_apis_organizationId_name" ON "apis" ("organizationId", "name")`);

    // ──────────────────────────────────────────────
    // 7. credentials (FKs: apis, organizations)
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
        CONSTRAINT "PK_credentials" PRIMARY KEY ("id"),
        CONSTRAINT "FK_credentials_apiId" FOREIGN KEY ("apiId") REFERENCES "apis"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_credentials_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    // ──────────────────────────────────────────────
    // 8. llm_providers (FKs: organizations, credentials)
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
        CONSTRAINT "PK_llm_providers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_llm_providers_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_llm_providers_credentialId" FOREIGN KEY ("credentialId") REFERENCES "credentials"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_llm_providers_organizationId_name" ON "llm_providers" ("organizationId", "name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_llm_providers_type_status" ON "llm_providers" ("type", "status")`);

    // ──────────────────────────────────────────────
    // 9. api_schemas (FK: apis)
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
        CONSTRAINT "PK_api_schemas" PRIMARY KEY ("id"),
        CONSTRAINT "FK_api_schemas_apiId" FOREIGN KEY ("apiId") REFERENCES "apis"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_api_schemas_apiId" ON "api_schemas" ("apiId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_api_schemas_apiId_version" ON "api_schemas" ("apiId", "version")`);

    // ──────────────────────────────────────────────
    // 10. json_schemas (FK: api_schemas)
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
        CONSTRAINT "PK_json_schemas" PRIMARY KEY ("id"),
        CONSTRAINT "FK_json_schemas_sourceSchemaId" FOREIGN KEY ("sourceSchemaId") REFERENCES "api_schemas"("id") ON DELETE CASCADE
      )
    `);

    // ──────────────────────────────────────────────
    // 11. resources (FK: apis)
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
        CONSTRAINT "PK_resources" PRIMARY KEY ("id"),
        CONSTRAINT "FK_resources_apiId" FOREIGN KEY ("apiId") REFERENCES "apis"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_resources_apiId" ON "resources" ("apiId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_resources_apiId_type" ON "resources" ("apiId", "type")`);

    // ──────────────────────────────────────────────
    // 12. operations (FKs: apis, resources)
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
        CONSTRAINT "PK_operations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_operations_apiId" FOREIGN KEY ("apiId") REFERENCES "apis"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_operations_resourceId" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_operations_apiId" ON "operations" ("apiId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_operations_apiId_isActive" ON "operations" ("apiId", "isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_operations_apiId_deprecated" ON "operations" ("apiId", "deprecated")`);

    // ──────────────────────────────────────────────
    // 13. tool_categories (self-referential closure table tree)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_categories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" character varying,
        "slug" character varying NOT NULL,
        "organizationId" character varying NOT NULL,
        "icon" character varying,
        "color" character varying,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "parentId" uuid,
        CONSTRAINT "PK_tool_categories" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tool_categories_slug" UNIQUE ("slug"),
        CONSTRAINT "FK_tool_categories_parentId" FOREIGN KEY ("parentId") REFERENCES "tool_categories"("id") ON DELETE NO ACTION
      )
    `);

    // Closure table for tree hierarchy
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_categories_closure" (
        "id_ancestor" uuid NOT NULL,
        "id_descendant" uuid NOT NULL,
        CONSTRAINT "PK_tool_categories_closure" PRIMARY KEY ("id_ancestor", "id_descendant"),
        CONSTRAINT "FK_tool_categories_closure_ancestor" FOREIGN KEY ("id_ancestor") REFERENCES "tool_categories"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tool_categories_closure_descendant" FOREIGN KEY ("id_descendant") REFERENCES "tool_categories"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_categories_closure_ancestor" ON "tool_categories_closure" ("id_ancestor")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_categories_closure_descendant" ON "tool_categories_closure" ("id_descendant")`);

    // ──────────────────────────────────────────────
    // 14. tools (FKs: operations, apis, organizations, json_schemas)
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
        "definitionHash" character varying(64),
        "usageCount" integer NOT NULL DEFAULT 0,
        "lastUsedAt" TIMESTAMP,
        "successRate" integer NOT NULL DEFAULT 0,
        "averageResponseTime" integer NOT NULL DEFAULT 0,
        "createdBy" character varying,
        "updatedBy" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tools" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tools_operationId" FOREIGN KEY ("operationId") REFERENCES "operations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tools_apiId" FOREIGN KEY ("apiId") REFERENCES "apis"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_tools_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tools_inputSchemaId" FOREIGN KEY ("inputSchemaId") REFERENCES "json_schemas"("id") ON DELETE NO ACTION,
        CONSTRAINT "FK_tools_outputSchemaId" FOREIGN KEY ("outputSchemaId") REFERENCES "json_schemas"("id") ON DELETE NO ACTION
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tools_name_operationId" ON "tools" ("name", "operationId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tools_organizationId_name" ON "tools" ("organizationId", "name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tools_organizationId_status" ON "tools" ("organizationId", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tools_organizationId_createdAt" ON "tools" ("organizationId", "createdAt")`);

    // ManyToMany join table: tools <-> tool_categories
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_categories_mapping" (
        "toolId" uuid NOT NULL,
        "categoryId" uuid NOT NULL,
        CONSTRAINT "PK_tool_categories_mapping" PRIMARY KEY ("toolId", "categoryId"),
        CONSTRAINT "FK_tool_categories_mapping_toolId" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_tool_categories_mapping_categoryId" FOREIGN KEY ("categoryId") REFERENCES "tool_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_categories_mapping_toolId" ON "tool_categories_mapping" ("toolId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_categories_mapping_categoryId" ON "tool_categories_mapping" ("categoryId")`);

    // ──────────────────────────────────────────────
    // 15. tool_versions (FK: tools)
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
        CONSTRAINT "PK_tool_versions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tool_versions_toolId" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE CASCADE
      )
    `);

    // ──────────────────────────────────────────────
    // 16. tool_executions (FKs: tools, users, organizations)
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
        CONSTRAINT "PK_tool_executions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tool_executions_toolId" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tool_executions_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_tool_executions_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_executions_toolId" ON "tool_executions" ("toolId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_executions_userId" ON "tool_executions" ("userId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_executions_organizationId" ON "tool_executions" ("organizationId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_executions_gatewayId" ON "tool_executions" ("gatewayId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_executions_success" ON "tool_executions" ("success")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_executions_toolId_organizationId_createdAt" ON "tool_executions" ("toolId", "organizationId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_executions_userId_createdAt" ON "tool_executions" ("userId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_executions_success_createdAt" ON "tool_executions" ("success", "createdAt")`);

    // ──────────────────────────────────────────────
    // 17. tool_templates (FK: organizations)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tool_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" text,
        "provider" character varying(100) NOT NULL,
        "providerIcon" character varying(500),
        "category" character varying(100) NOT NULL,
        "tags" text[] NOT NULL DEFAULT '{}',
        "executionMethod" character varying(50) NOT NULL,
        "httpConfig" json,
        "parameters" json NOT NULL DEFAULT '{}',
        "configuration" json NOT NULL DEFAULT '{}',
        "examples" json NOT NULL DEFAULT '[]',
        "apiConfig" json,
        "sdkConfig" jsonb,
        "sdkMap" jsonb,
        "isBuiltIn" boolean NOT NULL DEFAULT false,
        "organizationId" uuid,
        "visibility" character varying(20) NOT NULL DEFAULT 'public',
        "version" character varying(20) NOT NULL DEFAULT '1.0.0',
        "installCount" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tool_templates" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tool_templates_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_templates_provider" ON "tool_templates" ("provider")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_templates_category" ON "tool_templates" ("category")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tool_templates_organizationId" ON "tool_templates" ("organizationId")`);

    // ──────────────────────────────────────────────
    // 18. agents (FK: organizations)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agents" (
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
        "mode" character varying NOT NULL DEFAULT 'workflow',
        "instructions" text,
        "personality" text,
        "heartbeat" json,
        "toolIds" uuid[] NOT NULL DEFAULT '{}',
        "modelConfig" json,
        "memoryConfig" json,
        "agentConfig" json,
        "isTemporary" boolean NOT NULL DEFAULT false,
        "parentRunId" character varying,
        "collaboration" json,
        "webhookUrl" character varying,
        "totalExecutions" integer NOT NULL DEFAULT 0,
        "successfulExecutions" integer NOT NULL DEFAULT 0,
        "totalCost" double precision NOT NULL DEFAULT 0,
        "averageExecutionTime" integer NOT NULL DEFAULT 0,
        "lastExecutedAt" TIMESTAMP,
        "createdBy" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_agents_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_agents_organizationId_name" ON "agents" ("organizationId", "name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_agents_organizationId_status" ON "agents" ("organizationId", "status")`);

    // ──────────────────────────────────────────────
    // 19. agent_executions (FKs: agents, organizations)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_executions" (
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
        CONSTRAINT "PK_agent_executions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_agent_executions_agentId" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_agent_executions_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_agent_executions_agentId_createdAt" ON "agent_executions" ("agentId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_agent_executions_organizationId_createdAt" ON "agent_executions" ("organizationId", "createdAt")`);

    // ──────────────────────────────────────────────
    // 20. gateways (FKs: organizations, agents)
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
        CONSTRAINT "PK_gateways" PRIMARY KEY ("id"),
        CONSTRAINT "FK_gateways_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_gateways_agentId" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_gateways_organizationId_name" ON "gateways" ("organizationId", "name")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_gateways_organizationId_endpoint" ON "gateways" ("organizationId", "endpoint")`);

    // ──────────────────────────────────────────────
    // 21. api_keys (FKs: users, organizations, gateways)
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
        "agentId" character varying,
        "isActive" boolean NOT NULL DEFAULT true,
        "expiresAt" TIMESTAMP,
        "lastUsedAt" TIMESTAMP,
        "scopes" json,
        "rateLimits" json,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_api_keys" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_api_keys_keyHash" UNIQUE ("keyHash"),
        CONSTRAINT "FK_api_keys_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_api_keys_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_api_keys_gatewayId" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_api_keys_keyHash" ON "api_keys" ("keyHash")`);

    // ──────────────────────────────────────────────
    // 22. gateway_tools (FKs: gateways, tools)
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
        CONSTRAINT "PK_gateway_tools" PRIMARY KEY ("id"),
        CONSTRAINT "FK_gateway_tools_gatewayId" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_gateway_tools_toolId" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_gateway_tools_gatewayId_toolId" ON "gateway_tools" ("gatewayId", "toolId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_gateway_tools_toolId_isActive" ON "gateway_tools" ("toolId", "isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_gateway_tools_gatewayId_isActive" ON "gateway_tools" ("gatewayId", "isActive")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_gateway_tools_gatewayId_usageCount" ON "gateway_tools" ("gatewayId", "usageCount")`);

    // ──────────────────────────────────────────────
    // 23. gateway_auth (FK: gateways)
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
        CONSTRAINT "PK_gateway_auth" PRIMARY KEY ("id"),
        CONSTRAINT "FK_gateway_auth_gatewayId" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE CASCADE
      )
    `);

    // ──────────────────────────────────────────────
    // 24. conversations (FKs: organizations, agents, gateways, users, llm_providers, self-ref)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "conversations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "externalSessionId" character varying,
        "providerId" uuid,
        "agentId" uuid,
        "externalAgentId" character varying,
        "parentConversationId" uuid,
        "gatewayId" uuid,
        "userId" uuid,
        "organizationId" uuid NOT NULL,
        "status" character varying NOT NULL DEFAULT 'active',
        "title" character varying,
        "context" json,
        "messageCount" integer NOT NULL DEFAULT 0,
        "totalInputTokens" integer NOT NULL DEFAULT 0,
        "totalOutputTokens" integer NOT NULL DEFAULT 0,
        "totalCost" double precision NOT NULL DEFAULT 0,
        "toolCalls" integer NOT NULL DEFAULT 0,
        "successfulToolCalls" integer NOT NULL DEFAULT 0,
        "lastActivityAt" TIMESTAMP,
        "completedAt" TIMESTAMP,
        "failureReason" character varying,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_conversations_providerId" FOREIGN KEY ("providerId") REFERENCES "llm_providers"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_conversations_agentId" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_conversations_parentConversationId" FOREIGN KEY ("parentConversationId") REFERENCES "conversations"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_conversations_gatewayId" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_conversations_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_conversations_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_providerId_status" ON "conversations" ("providerId", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_gatewayId_status" ON "conversations" ("gatewayId", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_organizationId_createdAt" ON "conversations" ("organizationId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_userId_createdAt" ON "conversations" ("userId", "createdAt")`);

    // ──────────────────────────────────────────────
    // 25. messages (FK: conversations)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversationId" uuid NOT NULL,
        "runId" character varying,
        "role" character varying NOT NULL,
        "type" character varying NOT NULL DEFAULT 'text',
        "status" character varying NOT NULL DEFAULT 'completed',
        "content" text,
        "contentParts" json,
        "toolCalls" json,
        "functionCall" json,
        "toolCallId" character varying,
        "functionName" character varying,
        "inputTokens" integer NOT NULL DEFAULT 0,
        "outputTokens" integer NOT NULL DEFAULT 0,
        "cost" double precision NOT NULL DEFAULT 0,
        "responseTime" integer,
        "model" character varying,
        "parameters" json,
        "finishReason" character varying,
        "error" character varying,
        "externalMessageId" character varying,
        "parts" json,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_messages_conversationId" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_conversationId_createdAt" ON "messages" ("conversationId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_role_type" ON "messages" ("role", "type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_status_createdAt" ON "messages" ("status", "createdAt")`);

    // ──────────────────────────────────────────────
    // 26. agent_runs (FKs: agents, organizations, conversations)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "agentId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "userId" character varying,
        "conversationId" uuid,
        "mode" character varying NOT NULL DEFAULT 'workflow',
        "status" character varying NOT NULL DEFAULT 'pending',
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
        "parentRunId" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_runs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_agent_runs_agentId" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_agent_runs_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_agent_runs_conversationId" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_agent_runs_agentId_createdAt" ON "agent_runs" ("agentId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_agent_runs_organizationId_createdAt" ON "agent_runs" ("organizationId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_agent_runs_status" ON "agent_runs" ("status")`);

    // ──────────────────────────────────────────────
    // 27. memories (FK: organizations)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "memories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "type" character varying NOT NULL,
        "content" text NOT NULL,
        "embedding" double precision[],
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
        CONSTRAINT "PK_memories" PRIMARY KEY ("id"),
        CONSTRAINT "FK_memories_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_memories_organizationId_scope" ON "memories" ("organizationId", "scope")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_memories_organizationId_type" ON "memories" ("organizationId", "type")`);

    // ──────────────────────────────────────────────
    // 28. files (FK: organizations)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "files" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "agentId" character varying,
        "runId" character varying,
        "name" character varying NOT NULL,
        "mimeType" character varying NOT NULL,
        "size" integer NOT NULL DEFAULT 0,
        "storageKey" character varying NOT NULL,
        "storageUrl" character varying,
        "extractedText" text,
        "memoryId" character varying,
        "uploadedBy" character varying,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_files" PRIMARY KEY ("id"),
        CONSTRAINT "FK_files_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_files_organizationId" ON "files" ("organizationId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_files_agentId" ON "files" ("agentId")`);

    // ──────────────────────────────────────────────
    // 29. external_agents (FKs: organizations, credentials)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "external_agents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "description" text,
        "agentCardUrl" text NOT NULL,
        "cachedCard" json,
        "cardLastFetchedAt" TIMESTAMP,
        "baseRpcUrl" text,
        "credentialId" uuid,
        "selectedSecurityScheme" text,
        "capabilities" json,
        "status" text NOT NULL DEFAULT 'active',
        "lastHealthCheckAt" TIMESTAMP,
        "totalRequests" integer NOT NULL DEFAULT 0,
        "successfulRequests" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_external_agents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_external_agents_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_external_agents_credentialId" FOREIGN KEY ("credentialId") REFERENCES "credentials"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_external_agents_organizationId" ON "external_agents" ("organizationId")`);

    // ──────────────────────────────────────────────
    // 30. oauth_clients (FKs: gateways, organizations)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "oauth_clients" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "clientId" character varying NOT NULL,
        "clientSecretHash" character varying,
        "clientName" character varying NOT NULL,
        "clientUri" character varying,
        "redirectUris" json NOT NULL,
        "grantTypes" json NOT NULL DEFAULT '["authorization_code","refresh_token"]',
        "responseTypes" json NOT NULL DEFAULT '["code"]',
        "scope" character varying,
        "tokenEndpointAuthMethod" character varying NOT NULL DEFAULT 'none',
        "gatewayId" uuid,
        "organizationId" uuid NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "metadata" json,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_oauth_clients" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_oauth_clients_clientId" UNIQUE ("clientId"),
        CONSTRAINT "FK_oauth_clients_gatewayId" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_oauth_clients_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_oauth_clients_clientId" ON "oauth_clients" ("clientId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_clients_organizationId" ON "oauth_clients" ("organizationId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_clients_gatewayId" ON "oauth_clients" ("gatewayId")`);

    // ──────────────────────────────────────────────
    // 31. oauth_authorization_codes (FKs: oauth_clients via clientId, users, gateways, organizations)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "codeHash" character varying NOT NULL,
        "clientId" character varying NOT NULL,
        "userId" uuid,
        "gatewayId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "redirectUri" character varying NOT NULL,
        "scope" character varying,
        "codeChallenge" character varying NOT NULL,
        "codeChallengeMethod" character varying NOT NULL DEFAULT 'S256',
        "resource" character varying,
        "state" character varying,
        "expiresAt" TIMESTAMP NOT NULL,
        "isUsed" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_oauth_authorization_codes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_oauth_authorization_codes_codeHash" UNIQUE ("codeHash"),
        CONSTRAINT "FK_oauth_authorization_codes_clientId" FOREIGN KEY ("clientId") REFERENCES "oauth_clients"("clientId") ON DELETE CASCADE,
        CONSTRAINT "FK_oauth_authorization_codes_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_oauth_authorization_codes_gatewayId" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_oauth_authorization_codes_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_oauth_authorization_codes_codeHash" ON "oauth_authorization_codes" ("codeHash")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_authorization_codes_clientId" ON "oauth_authorization_codes" ("clientId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_authorization_codes_expiresAt" ON "oauth_authorization_codes" ("expiresAt")`);

    // ──────────────────────────────────────────────
    // 32. oauth_access_tokens (FKs: oauth_clients via clientId, users, gateways, organizations, self-ref)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "oauth_access_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tokenHash" character varying NOT NULL,
        "tokenType" character varying NOT NULL,
        "clientId" character varying NOT NULL,
        "userId" uuid,
        "gatewayId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "scope" character varying,
        "resource" character varying,
        "expiresAt" TIMESTAMP NOT NULL,
        "isRevoked" boolean NOT NULL DEFAULT false,
        "parentTokenId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_oauth_access_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_oauth_access_tokens_tokenHash" UNIQUE ("tokenHash"),
        CONSTRAINT "FK_oauth_access_tokens_clientId" FOREIGN KEY ("clientId") REFERENCES "oauth_clients"("clientId") ON DELETE CASCADE,
        CONSTRAINT "FK_oauth_access_tokens_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_oauth_access_tokens_gatewayId" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_oauth_access_tokens_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_oauth_access_tokens_parentTokenId" FOREIGN KEY ("parentTokenId") REFERENCES "oauth_access_tokens"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_oauth_access_tokens_tokenHash" ON "oauth_access_tokens" ("tokenHash")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_access_tokens_clientId" ON "oauth_access_tokens" ("clientId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_access_tokens_userId" ON "oauth_access_tokens" ("userId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_access_tokens_expiresAt" ON "oauth_access_tokens" ("expiresAt")`);

    // ──────────────────────────────────────────────
    // 33. usage_metrics (FKs: organizations, gateways, tools, llm_providers)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "usage_metrics" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" character varying NOT NULL,
        "value" decimal(15,4) NOT NULL,
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
        CONSTRAINT "PK_usage_metrics" PRIMARY KEY ("id"),
        CONSTRAINT "FK_usage_metrics_gatewayId" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_usage_metrics_toolId" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_usage_metrics_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_usage_metrics_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_usage_metrics_llmProviderId" FOREIGN KEY ("llmProviderId") REFERENCES "llm_providers"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_usage_metrics_timestamp_type" ON "usage_metrics" ("timestamp", "type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_usage_metrics_gatewayId_timestamp" ON "usage_metrics" ("gatewayId", "timestamp")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_usage_metrics_organizationId_timestamp" ON "usage_metrics" ("organizationId", "timestamp")`);

    // ──────────────────────────────────────────────
    // 34. request_logs (FKs: gateways, tools, users)
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
        CONSTRAINT "PK_request_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_request_logs_gatewayId" FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_request_logs_toolId" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_request_logs_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_request_logs_timestamp" ON "request_logs" ("timestamp")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_request_logs_gatewayId_timestamp" ON "request_logs" ("gatewayId", "timestamp")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_request_logs_statusCode" ON "request_logs" ("statusCode")`);

    // ──────────────────────────────────────────────
    // 35. audit_logs (FK: organizations)
    // ──────────────────────────────────────────────
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
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_audit_logs_organizationId" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_organizationId_createdAt" ON "audit_logs" ("organizationId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_resourceType_resourceId" ON "audit_logs" ("resourceType", "resourceId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_userId_createdAt" ON "audit_logs" ("userId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON "audit_logs" ("action")`);

    // ──────────────────────────────────────────────
    // 36. version table (typeorm-versions)
    // ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "version" (
        "id" SERIAL NOT NULL,
        "itemType" character varying NOT NULL,
        "itemId" character varying NOT NULL,
        "event" character varying NOT NULL,
        "owner" character varying NOT NULL,
        "object" text NOT NULL,
        "timestamp" TIMESTAMP(6) NOT NULL,
        CONSTRAINT "PK_version" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables in reverse dependency order
    await queryRunner.query(`DROP TABLE IF EXISTS "version" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "request_logs" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_metrics" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "oauth_access_tokens" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "oauth_authorization_codes" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "oauth_clients" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "external_agents" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "files" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "memories" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_runs" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversations" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "gateway_auth" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "gateway_tools" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "gateways" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_executions" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agents" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_templates" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_executions" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_versions" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_categories_mapping" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tools" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_categories_closure" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tool_categories" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "operations" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "resources" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "json_schemas" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_schemas" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_providers" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "credentials" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "apis" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_teams" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "teams" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_organizations" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organizations" CASCADE`);
  }
}
