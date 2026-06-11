import { MigrationInterface, QueryRunner } from 'typeorm';
import { encryptField, isEncrypted } from '../common/security/field-crypto';

/**
 * Encrypt LLM provider API keys that were previously stored in plaintext in
 * the llm_providers.configuration JSON column. Idempotent: rows whose
 * apiKey is already `encrypted:` are skipped, so re-running is safe.
 *
 * Requires ENCRYPTION_KEY in the environment (the migration Job provides
 * it, same as the credential upgrade migration).
 */
export class EncryptLlmProviderKeys1745380000000 implements MigrationInterface {
  name = 'EncryptLlmProviderKeys1745380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ id: string; configuration: any }> = await queryRunner.query(
      `SELECT id, configuration FROM llm_providers`,
    );

    for (const row of rows) {
      const config = row.configuration;
      const key = config?.apiKey;
      if (typeof key !== 'string' || key.length === 0 || isEncrypted(key)) {
        continue;
      }
      const updated = { ...config, apiKey: encryptField(key) };
      await queryRunner.query(
        `UPDATE llm_providers SET configuration = $1::json WHERE id = $2`,
        [JSON.stringify(updated), row.id],
      );
    }
  }

  public async down(): Promise<void> {
    // Intentionally a no-op: we do not decrypt secrets back to plaintext on
    // rollback. Decryption stays read-compatible, so encrypted rows keep
    // working on an older build.
  }
}
