import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `org_kms_configs.retiredDeks` — the wrapped DEKs an organization has
 * rotated away from.
 *
 * Under BYO-KMS a rotation mints a new Data Encryption Key; the values already
 * sealed under the previous one are identified by the key id carried in their
 * ciphertext and are unwrapped with the DEK named by that id. This column is
 * where those superseded wrapped blobs live, alongside the CMK reference each
 * one needs to be unwrapped (a rotation can move the org to a different CMK,
 * and a retired DEK stays wrapped by the CMK that wrapped it).
 *
 * It holds ciphertext only: each entry is a KMS `CiphertextBlob` that almyty
 * cannot decrypt without the customer's CMK, plus public key identifiers.
 * A single jsonb column rather than a child table because the collection is
 * bounded by an org's rotation count, is only ever read together with the row
 * that owns it, and must be rewritten in the same atomic update that installs
 * the new active DEK.
 */
export class OrgKmsRetiredDeks1750804000000 implements MigrationInterface {
  name = 'OrgKmsRetiredDeks1750804000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "org_kms_configs"
      ADD COLUMN IF NOT EXISTS "retiredDeks" jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "org_kms_configs" DROP COLUMN IF EXISTS "retiredDeks"
    `);
  }
}
