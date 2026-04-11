import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateExternalAgents1744700000000 implements MigrationInterface {
  name = 'CreateExternalAgents1744700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "external_agents" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "name" varchar NOT NULL,
        "description" text,
        "agentCardUrl" text NOT NULL,
        "cachedCard" json,
        "cardLastFetchedAt" timestamptz,
        "baseRpcUrl" text,
        "credentialId" uuid,
        "selectedSecurityScheme" text,
        "capabilities" json,
        "status" text NOT NULL DEFAULT 'active',
        "lastHealthCheckAt" timestamptz,
        "totalRequests" int NOT NULL DEFAULT 0,
        "successfulRequests" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_external_agents_organization"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_external_agents_credential"
          FOREIGN KEY ("credentialId") REFERENCES "credentials"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_external_agents_organizationId" ON "external_agents" ("organizationId")`,
    );

    // Add the deferred FK from conversations.externalAgentId -> external_agents.id
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD CONSTRAINT "FK_conversations_externalAgent"
        FOREIGN KEY ("externalAgentId") REFERENCES "external_agents"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "FK_conversations_externalAgent"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "external_agents" CASCADE`);
  }
}
