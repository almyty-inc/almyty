import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marks an MCP OAuth authorization code that was presented twice, so the
 * redemption that won the race revokes the pair it minted once it sees the
 * mark. See McpOAuthTokensHelper.exchangeCode.
 */
export class OAuthCodeReuseDetected1750813520000 implements MigrationInterface {
  name = 'OAuthCodeReuseDetected1750813520000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "oauth_authorization_codes" ADD COLUMN "reuseDetectedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "oauth_authorization_codes" DROP COLUMN "reuseDetectedAt"`);
  }
}
