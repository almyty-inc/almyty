import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Take platform secrets off distribution rows.
 *
 * A distribution's bot token, signing secret, Twilio auth token and the
 * like used to be stored in plain JSON on
 * `agent_app_distributions.configuration`. They now live in a credential
 * the distribution manages (agent-apps/distribution-secrets.ts). This drops
 * whatever is still inline. A published distribution keeps working: its
 * gateway moved its own copy into the credential store when it was
 * published. A draft asks for its credentials again before it can go live.
 *
 * The key list is the channel secret list as of this migration, written
 * out so a later change to the code cannot change what this did.
 */
const SECRET_KEYS = [
  'client_secret', 'clientSecret',
  'bot_token', 'botToken',
  'webhook_secret_token',
  'bot_password', 'botPassword',
  'signing_secret', 'signingSecret',
  'auth_token', 'authToken', 'twilio_auth_token',
  'access_token', 'accessToken',
  'app_secret', 'appSecret',
  'verify_token',
  'resend_api_key', 'resendApiKey', 'resend_inbound_signing_secret',
  'bridge_token', 'inbound_token',
  'secret',
  'verification_token',
];

export class DistributionSecretsOffRow1750810710000 implements MigrationInterface {
  name = 'DistributionSecretsOffRow1750810710000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "agent_app_distributions"
          SET "configuration" = ("configuration"::jsonb - $1::text[])::json
        WHERE "configuration" IS NOT NULL
          AND "configuration"::jsonb ?| $1::text[]`,
      [SECRET_KEYS],
    );
  }

  public async down(): Promise<void> {
    // Nothing to restore: the secrets are gone on purpose.
  }
}
