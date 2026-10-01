import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MCP OAuth clients registered without a registration step.
 *
 * A Client ID Metadata Document client (MCP 2025-11-25 authorization) names
 * itself by an https URL; the authorization server fetches the client's
 * metadata from that URL. Its `oauth_clients` row is keyed by the URL
 * (`clientId`), so authorization codes and tokens keep their foreign key and
 * revocation works as for a registered client. The client is not owned by
 * an organization or a gateway: the same URL is the same client everywhere
 * (its codes and tokens carry their own gateway and organization), so
 * `organizationId` may be null on exactly those rows.
 *
 * `applicationType` is the OIDC / RFC 7591 `application_type` a client
 * registers as (MCP 2026-07-28, SEP-837): `web` needs https redirect URIs,
 * `native` may use loopback http and private-use schemes.
 */
export class McpClientRegistration1750813798000 implements MigrationInterface {
  name = 'McpClientRegistration1750813798000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "applicationType" varchar(16) NOT NULL DEFAULT 'web'`,
    );
    await queryRunner.query(
      `ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "isMetadataDocument" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "metadataFetchedAt" timestamptz NULL`);
    await queryRunner.query(`ALTER TABLE "oauth_clients" ALTER COLUMN "organizationId" DROP NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "oauth_clients" ADD CONSTRAINT "CHK_oauth_clients_application_type" CHECK ("applicationType" IN ('web', 'native'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "oauth_clients" ADD CONSTRAINT "CHK_oauth_clients_owner" CHECK ("isMetadataDocument" OR "organizationId" IS NOT NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "oauth_clients" DROP CONSTRAINT IF EXISTS "CHK_oauth_clients_owner"`);
    await queryRunner.query(`ALTER TABLE "oauth_clients" DROP CONSTRAINT IF EXISTS "CHK_oauth_clients_application_type"`);
    await queryRunner.query(`DELETE FROM "oauth_clients" WHERE "organizationId" IS NULL`);
    await queryRunner.query(`ALTER TABLE "oauth_clients" ALTER COLUMN "organizationId" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "oauth_clients" DROP COLUMN IF EXISTS "metadataFetchedAt"`);
    await queryRunner.query(`ALTER TABLE "oauth_clients" DROP COLUMN IF EXISTS "isMetadataDocument"`);
    await queryRunner.query(`ALTER TABLE "oauth_clients" DROP COLUMN IF EXISTS "applicationType"`);
  }
}
