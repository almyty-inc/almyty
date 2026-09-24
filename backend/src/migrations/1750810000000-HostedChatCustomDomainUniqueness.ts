import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One live owner per custom hostname.
 *
 * A hosted-chat custom domain is a global public address, like a slug.
 * Several surfaces may hold a PENDING claim on the same hostname (only
 * one of them can publish the TXT record, and letting a squatter's
 * pending row block the real owner would be its own outage), but only
 * one may be ACTIVE: the verify path flips its row to active and relies
 * on this index to refuse a second, whichever tenant and organization it
 * belongs to.
 */
export class HostedChatCustomDomainUniqueness1750810000000 implements MigrationInterface {
  name = 'HostedChatCustomDomainUniqueness1750810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_gateways_custom_domain_active"
      ON "gateways" ((("configuration" -> 'customDomain' ->> 'hostname')))
      WHERE "type" = 'hosted_chat'
        AND ("configuration" -> 'customDomain' ->> 'status') = 'active'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_gateways_custom_domain_active"`);
  }
}
