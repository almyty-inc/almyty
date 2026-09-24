import { MigrationInterface, QueryRunner } from 'typeorm';

import { redactVersionSnapshot } from '../common/version-snapshot-redaction';

/**
 * Take the secrets out of the version snapshots already written.
 *
 * The version subscriber used to serialize every @VersionedEntity whole,
 * so each credential snapshot carried the secret the credential held at
 * that moment, and a rotated or wiped key lived on in every earlier row.
 * New snapshots are redacted as they are written
 * (common/version-snapshot-redaction.ts); this applies the same redaction
 * to the rows that exist. Walked by id in batches so a large table is
 * never loaded at once; a row is only rewritten when redaction changed it.
 */
export class RedactVersionSnapshots1750810700000 implements MigrationInterface {
  name = 'RedactVersionSnapshots1750810700000';

  private static readonly BATCH = 500;

  public async up(queryRunner: QueryRunner): Promise<void> {
    let lastId = 0;
    for (;;) {
      const rows: Array<{ id: number; object: string }> = await queryRunner.query(
        `SELECT "id", "object" FROM "version" WHERE "id" > $1 ORDER BY "id" ASC LIMIT $2`,
        [lastId, RedactVersionSnapshots1750810700000.BATCH],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        lastId = Number(row.id);
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.object);
        } catch {
          // Not JSON, so not something the subscriber wrote; nothing to read a secret out of.
          continue;
        }
        const redacted = JSON.stringify(redactVersionSnapshot(parsed));
        if (redacted !== JSON.stringify(parsed)) {
          await queryRunner.query(`UPDATE "version" SET "object" = $1 WHERE "id" = $2`, [redacted, row.id]);
        }
      }
    }
  }

  public async down(): Promise<void> {
    // Nothing to restore: the secrets are gone on purpose.
  }
}
