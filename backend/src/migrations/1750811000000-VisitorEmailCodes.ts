import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `visitor_email_codes`: one-time sign-in codes for hosted-chat surfaces
 * set to email verification.
 *
 * Only a keyed hash of the code is stored. A code belongs to the visitor
 * row (browser session) that asked for it, so it cannot be redeemed from
 * another browser; it is single-use (`consumedAt`), short-lived
 * (`expiresAt`) and allows a bounded number of wrong guesses
 * (`attempts`), all enforced by conditional UPDATEs rather than by
 * read-then-write. Rows go with their surface and visitor, and an expiry
 * sweep removes the rest.
 */
export class VisitorEmailCodes1750811000000 implements MigrationInterface {
  name = 'VisitorEmailCodes1750811000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "visitor_email_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "gatewayId" uuid NOT NULL,
        "endUserId" uuid NOT NULL,
        "email" character varying(320) NOT NULL,
        "clientHash" character varying,
        "codeHash" character varying(64) NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_visitor_email_codes" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_visitor_email_codes_visitor"
      ON "visitor_email_codes" ("gatewayId", "endUserId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_visitor_email_codes_expires"
      ON "visitor_email_codes" ("expiresAt")
    `);
    await queryRunner.query(`
      ALTER TABLE "visitor_email_codes"
      ADD CONSTRAINT "FK_visitor_email_codes_organization"
      FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "visitor_email_codes"
      ADD CONSTRAINT "FK_visitor_email_codes_gateway"
      FOREIGN KEY ("gatewayId") REFERENCES "gateways"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "visitor_email_codes"
      ADD CONSTRAINT "FK_visitor_email_codes_end_user"
      FOREIGN KEY ("endUserId") REFERENCES "end_users"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "visitor_email_codes"`);
  }
}
