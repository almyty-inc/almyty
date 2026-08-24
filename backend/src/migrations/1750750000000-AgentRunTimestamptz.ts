import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store agent run timestamps with their time zone.
 *
 * `createdAt` was `timestamp without time zone`. Postgres writes UTC
 * into it (the server runs Etc/UTC), but node-postgres has no zone to
 * work from when reading one back, so it parses the value in the Node
 * process's LOCAL zone. On a machine at UTC+2 a run created one second
 * ago is read as two hours old.
 *
 * That is not cosmetic: `checkRunLimits` measures the wall-clock budget
 * as `Date.now() - createdAt`, so every run on a host ahead of UTC
 * failed instantly with TIMEOUT, and on a host behind UTC the timeout
 * could never fire at all. Production pods happen to run UTC, which
 * hid it until someone ran the stack in another zone.
 *
 * The stored values are already UTC, so the conversion states that
 * explicitly rather than reinterpreting anything: `AT TIME ZONE 'UTC'`
 * labels each existing value with the zone it was always in. Lossless
 * and reversible.
 */
export class AgentRunTimestamptz1750750000000 implements MigrationInterface {
  name = 'AgentRunTimestamptz1750750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_runs"
      ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE
      USING "createdAt" AT TIME ZONE 'UTC'
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_runs"
      ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITH TIME ZONE
      USING "updatedAt" AT TIME ZONE 'UTC'
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_runs" ALTER COLUMN "createdAt" SET DEFAULT now()
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_runs" ALTER COLUMN "updatedAt" SET DEFAULT now()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Back to a bare timestamp, normalising to UTC so the values are
    // unchanged in absolute terms.
    await queryRunner.query(`
      ALTER TABLE "agent_runs"
      ALTER COLUMN "createdAt" TYPE TIMESTAMP WITHOUT TIME ZONE
      USING "createdAt" AT TIME ZONE 'UTC'
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_runs"
      ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITHOUT TIME ZONE
      USING "updatedAt" AT TIME ZONE 'UTC'
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_runs" ALTER COLUMN "createdAt" SET DEFAULT now()
    `);
    await queryRunner.query(`
      ALTER TABLE "agent_runs" ALTER COLUMN "updatedAt" SET DEFAULT now()
    `);
  }
}
