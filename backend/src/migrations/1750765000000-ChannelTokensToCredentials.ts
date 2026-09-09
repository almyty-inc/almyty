import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Channel gateway tokens move to the credential store. The gateway row
 * keeps `configuration.credentialId` (the connection) and
 * `configuration.credentialKeys` (secret names, never values); the
 * values themselves are moved by the startup backfill
 * (ConsumerSecretBackfillService, gatewayChannels store). No column is
 * added: the reference lives in the existing json configuration. This
 * migration only indexes it so "which gateways use connection X" and
 * the release-on-disconnect lookups do not scan the table.
 */
export class ChannelTokensToCredentials1750765000000 implements MigrationInterface {
  name = 'ChannelTokensToCredentials1750765000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_gateways_channel_credential"
        ON "gateways" ((("configuration" ->> 'credentialId')))
        WHERE ("configuration" ->> 'credentialId') IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_gateways_channel_credential"`);
  }
}
