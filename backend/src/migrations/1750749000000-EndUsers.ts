import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `end_users`: people talking to an agent from outside the organization.
 *
 * Separate from `users`, who log in and build things. An end user may
 * never authenticate: an anonymous visitor still gets a row, keyed by a
 * per-surface cookie, with externalId and authProvider left null. That
 * is what lets "public by link" be a flag on the surface rather than a
 * second identity model, and lets email OTP or SSO fill in columns later
 * instead of forcing a retrofit.
 *
 * `conversations` gains `endUserId` so a hosted chat thread belongs to a
 * visitor rather than to a dashboard user. Existing rows keep null,
 * which is correct: every conversation that exists today came from a
 * gateway or a logged-in user, not from a hosted chat surface.
 */
export class EndUsers1750749000000 implements MigrationInterface {
  name = 'EndUsers1750749000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "end_users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "gatewayId" uuid NOT NULL,
        "sessionKey" character varying NOT NULL,
        "externalId" character varying,
        "authProvider" character varying,
        "email" character varying,
        "displayName" character varying,
        "clientHash" character varying,
        "lastSeenAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_end_users" PRIMARY KEY ("id")
      )
    `);

    // The same browser talking to two tenants is two different people,
    // so the session key is only unique within one surface.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_end_users_gateway_session"
      ON "end_users" ("gatewayId", "sessionKey")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_end_users_org_created"
      ON "end_users" ("organizationId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_end_users_gateway_external"
      ON "end_users" ("gatewayId", "externalId")
    `);

    await queryRunner.query(`
      ALTER TABLE "end_users"
      ADD CONSTRAINT "FK_end_users_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);
    // Deleting a surface takes its visitors with it: an end_user row is
    // meaningless without the surface it was scoped to.
    await queryRunner.query(`
      ALTER TABLE "end_users"
      ADD CONSTRAINT "FK_end_users_gateway"
      FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "conversations"
      ADD COLUMN IF NOT EXISTS "endUserId" uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_conversations_end_user_created"
      ON "conversations" ("endUserId", "createdAt")
    `);
    await queryRunner.query(`
      ALTER TABLE "conversations"
      ADD CONSTRAINT "FK_conversations_end_user"
      FOREIGN KEY ("endUserId") REFERENCES "end_users"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "FK_conversations_end_user"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversations_end_user_created"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "endUserId"`);

    await queryRunner.query(
      `ALTER TABLE "end_users" DROP CONSTRAINT IF EXISTS "FK_end_users_gateway"`,
    );
    await queryRunner.query(
      `ALTER TABLE "end_users" DROP CONSTRAINT IF EXISTS "FK_end_users_organization"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_end_users_gateway_external"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_end_users_org_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_end_users_gateway_session"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "end_users"`);
  }
}
