import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `org_kms_configs` for BYO-KMS (customer-managed CMK) envelope
 * encryption — an enterprise feature gated by the `byo_kms` entitlement.
 *
 * Each row holds a customer's AWS KMS CMK ARN and the org's Data Encryption
 * Key WRAPPED by that CMK (`wrappedDek`). The plaintext DEK is never persisted.
 * Orgs without a row keep using the platform-managed field-crypto key, so this
 * migration is purely additive and does not touch any existing encrypted data.
 */
export class OrgKmsConfig1750747000000 implements MigrationInterface {
  name = 'OrgKmsConfig1750747000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "org_kms_configs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" character varying NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "cmkArn" text,
        "awsRegion" character varying,
        "wrappedDek" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_org_kms_configs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_org_kms_configs_organizationId"
      ON "org_kms_configs" ("organizationId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_org_kms_configs_organizationId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "org_kms_configs"`);
  }
}
