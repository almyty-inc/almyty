import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOAuthTables1744800000000 implements MigrationInterface {
  name = 'CreateOAuthTables1744800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // oauth_clients
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "oauth_clients" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "clientId" varchar NOT NULL,
        "clientSecretHash" varchar,
        "clientName" varchar NOT NULL,
        "clientUri" varchar,
        "redirectUris" json NOT NULL,
        "grantTypes" json NOT NULL DEFAULT '["authorization_code","refresh_token"]',
        "responseTypes" json NOT NULL DEFAULT '["code"]',
        "scope" varchar,
        "tokenEndpointAuthMethod" varchar NOT NULL DEFAULT 'none',
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
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_clients_clientId" ON "oauth_clients" ("clientId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_clients_organizationId" ON "oauth_clients" ("organizationId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_oauth_clients_gatewayId" ON "oauth_clients" ("gatewayId")`);

    // oauth_authorization_codes
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "codeHash" varchar NOT NULL,
        "clientId" varchar NOT NULL,
        "userId" uuid,
        "gatewayId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "redirectUri" varchar NOT NULL,
        "scope" varchar,
        "codeChallenge" varchar NOT NULL,
        "codeChallengeMethod" varchar NOT NULL DEFAULT 'S256',
        "resource" varchar,
        "state" varchar,
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

    // oauth_access_tokens
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "oauth_access_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tokenHash" varchar NOT NULL,
        "tokenType" varchar NOT NULL,
        "clientId" varchar NOT NULL,
        "userId" uuid,
        "gatewayId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "scope" varchar,
        "resource" varchar,
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "oauth_access_tokens" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "oauth_authorization_codes" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "oauth_clients" CASCADE`);
  }
}
