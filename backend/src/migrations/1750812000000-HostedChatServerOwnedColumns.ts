import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Server-owned hosted chat columns: the custom domain claim and the
 * visitor OAuth provider.
 *
 * Neither lives in `gateways.configuration`, which the generic gateway
 * update writes whole: a save that loaded the row before a domain was
 * verified, removed or demoted would write the old claim back. The entity
 * marks both columns `update: false, insert: false`, so no TypeORM save
 * touches them; only their own services write them, with targeted SQL.
 *
 * One live owner per hostname, across every organization, is this index.
 */
export class HostedChatServerOwnedColumns1750812000000 implements MigrationInterface {
  name = 'HostedChatServerOwnedColumns1750812000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "gateways" ADD COLUMN IF NOT EXISTS "customDomain" jsonb`);
    await queryRunner.query(`ALTER TABLE "gateways" ADD COLUMN IF NOT EXISTS "visitorOAuth" jsonb`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_gateways_custom_domain_active"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_gateways_custom_domain_active"
      ON "gateways" (("customDomain" ->> 'hostname'))
      WHERE "type" = 'hosted_chat'
        AND ("customDomain" ->> 'status') = 'active'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_gateways_custom_domain_active"`);
    await queryRunner.query(`ALTER TABLE "gateways" DROP COLUMN IF EXISTS "visitorOAuth"`);
    await queryRunner.query(`ALTER TABLE "gateways" DROP COLUMN IF EXISTS "customDomain"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_gateways_custom_domain_active"
      ON "gateways" ((("configuration" -> 'customDomain' ->> 'hostname')))
      WHERE "type" = 'hosted_chat'
        AND ("configuration" -> 'customDomain' ->> 'status') = 'active'
    `);
  }
}
