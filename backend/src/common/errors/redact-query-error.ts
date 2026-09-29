import { DataSource, DataSourceOptions, QueryFailedError } from 'typeorm';

/**
 * A failed query's error carries the row it was writing.
 *
 * TypeORM's QueryFailedError keeps the statement's bound `parameters` (an
 * email, a token, a whole JSON document a data migration was moving) and
 * copies the driver's fields onto itself, among them Postgres' `detail`
 * ("Key (email)=(alice@example.com) already exists."). Anything that
 * prints the whole error prints those: `console.error(err)` in the typeorm
 * CLI when a migration fails, Nest's logger given the error object, a
 * Sentry event built from it, a BullMQ job's stored failure. The SQL text,
 * the message, the SQLSTATE `code` and the `constraint` name stay, since
 * a failure is diagnosed from those and code branches on them
 * (unique-violation.ts, the global exception filter).
 *
 * The error is changed in place, so every holder of it sees the redacted
 * one, and it is done where the error is born (redactQueryErrorsAtSource)
 * as well as at each printer, for errors from anywhere else.
 */
export const REDACTED = '[redacted]';

const REDACTED_FIELDS = ['detail'] as const;

function isQueryFailedError(error: unknown): error is QueryFailedError & Record<string, any> {
  if (error instanceof QueryFailedError) return true;
  // A second copy of typeorm (the CLI's, a test's) has its own class.
  return (
    !!error &&
    typeof error === 'object' &&
    (error as any).name === 'QueryFailedError' &&
    'query' in (error as object)
  );
}

function redactFields(target: Record<string, any> | null | undefined): void {
  if (!target || typeof target !== 'object') return;
  for (const field of REDACTED_FIELDS) {
    if (typeof target[field] === 'string' && target[field] !== REDACTED) {
      target[field] = REDACTED;
    }
  }
}

/** Redacts a QueryFailedError in place and returns it; anything else is returned untouched. */
export function redactQueryError<T>(error: T): T {
  if (!isQueryFailedError(error)) return error;
  const err = error as Record<string, any>;
  if (Array.isArray(err.parameters)) {
    err.parameters = err.parameters.map(() => REDACTED);
  } else if (err.parameters !== undefined && err.parameters !== null) {
    err.parameters = REDACTED;
  }
  redactFields(err);
  redactFields(err.driverError);
  return error;
}

const WRAPPED = Symbol.for('almyty.redactQueryErrorsAtSource');

/**
 * Every query this DataSource runs rethrows its QueryFailedError redacted.
 * All of TypeORM's querying (repositories, query builders, migrations,
 * `dataSource.query`) goes through a query runner's `query`, and every
 * query runner comes from the driver, so this is the one place a failed
 * query's error is created.
 */
export function redactQueryErrorsAtSource<T extends DataSource>(dataSource: T): T {
  const driver = dataSource.driver as any;
  if (driver[WRAPPED]) return dataSource;
  const createQueryRunner = driver.createQueryRunner.bind(driver);
  driver.createQueryRunner = (...args: unknown[]) => {
    const runner = createQueryRunner(...args);
    const query = runner.query.bind(runner);
    runner.query = async (...queryArgs: unknown[]) => {
      try {
        return await query(...queryArgs);
      } catch (error) {
        throw redactQueryError(error);
      }
    };
    return runner;
  };
  driver[WRAPPED] = true;
  return dataSource;
}

/**
 * TypeOrmModule's `dataSourceFactory` for the app and the test app: the
 * DataSource TypeORM would build, with redacted query errors.
 */
export function appDataSourceFactory(options?: DataSourceOptions): DataSource {
  if (!options) throw new Error('appDataSourceFactory needs the DataSource options');
  return redactQueryErrorsAtSource(new DataSource(options));
}
