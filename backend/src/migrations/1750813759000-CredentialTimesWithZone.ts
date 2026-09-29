import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Credential times carry their time zone.
 *
 * `createdAt`, `updatedAt`, `expiresAt`, `lastUsedAt` and
 * `healthCheckedAt` were `timestamp without time zone`. The column
 * defaults wrote the database's UTC clock while the app wrote its own
 * local time, and the driver reads such a value back as local time: on
 * any backend not running in UTC a credential added a minute ago said
 * "2h ago". The stored values are UTC (the defaults, and the app in its
 * UTC containers), so they convert as UTC.
 */
const COLUMNS = ['createdAt', 'updatedAt', 'expiresAt', 'lastUsedAt', 'healthCheckedAt'];

export class CredentialTimesWithZone1750813759000 implements MigrationInterface {
  name = 'CredentialTimesWithZone1750813759000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const column of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "credentials" ALTER COLUMN "${column}" TYPE timestamptz USING "${column}" AT TIME ZONE 'UTC'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "credentials" ALTER COLUMN "${column}" TYPE timestamp USING "${column}" AT TIME ZONE 'UTC'`,
      );
    }
  }
}
