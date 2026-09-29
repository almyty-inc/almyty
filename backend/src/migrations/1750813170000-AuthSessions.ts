import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Server-side record of each signed-in session, so logout and a replayed
 * refresh token can end a session whose JWTs have not expired yet.
 * See entities/auth-session.entity.ts.
 */
export class AuthSessions1750813170000 implements MigrationInterface {
  name = 'AuthSessions1750813170000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "auth_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "refreshJti" character varying(64) NOT NULL,
        "ssoOrganizationId" uuid,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "revokedReason" character varying(32),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_auth_sessions_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_sessions_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_auth_sessions_userId" ON "auth_sessions" ("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "auth_sessions"`);
  }
}
