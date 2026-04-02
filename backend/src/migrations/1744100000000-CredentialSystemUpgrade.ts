import { MigrationInterface, QueryRunner } from 'typeorm';

export class CredentialSystemUpgrade1744100000000 implements MigrationInterface {
  name = 'CredentialSystemUpgrade1744100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // New credential types (aws_sigv4, google_service_account, mtls) are handled
    // by the varchar type column — no schema change needed.
    // OAuth2 provider presets are application-level data, not schema.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No schema changes to revert
  }
}
