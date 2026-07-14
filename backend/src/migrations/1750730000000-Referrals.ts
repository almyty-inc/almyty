import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Invite/referral program (core, OSS).
 *
 * - referral_codes: one shareable code per user; banks accrued reward days
 *   for free-plan referrers (applied when the org is on pro).
 * - referrals: one row per referred signup; status pending -> qualified
 *   (referred org activated) -> rewarded (referred org converted to paid).
 *   Abuse-flagged rows never auto-reward.
 */
export class Referrals1750730000000 implements MigrationInterface {
  name = 'Referrals1750730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS referral_codes (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "organizationId" UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        "code" VARCHAR(32) NOT NULL,
        "active" BOOLEAN NOT NULL DEFAULT true,
        "accruedRewardDays" INTEGER NOT NULL DEFAULT 0,
        "createdFromIp" VARCHAR,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX referral_codes_user_idx ON referral_codes ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX referral_codes_code_idx ON referral_codes ("code")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "referrerUserId" UUID NOT NULL,
        "referredUserId" UUID NOT NULL,
        "referredOrganizationId" UUID NOT NULL,
        "referralCodeId" UUID,
        "status" VARCHAR NOT NULL DEFAULT 'pending',
        "qualifiedAt" TIMESTAMPTZ,
        "rewardedAt" TIMESTAMPTZ,
        "rewardDays" INTEGER NOT NULL DEFAULT 0,
        "abuseFlag" VARCHAR,
        "abuseReason" VARCHAR,
        "ipAddress" VARCHAR,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX referrals_referrer_idx ON referrals ("referrerUserId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX referrals_referred_user_idx ON referrals ("referredUserId")`,
    );
    await queryRunner.query(
      `CREATE INDEX referrals_status_idx ON referrals ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS referrals CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS referral_codes CASCADE`);
  }
}
