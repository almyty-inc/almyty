import { AdvancedConsoleLogger, LoggerOptions, QueryRunner } from 'typeorm';

/**
 * TypeORM's console logger prints a failing (or slow) query as
 * `query failed: <sql> -- PARAMETERS: [...]`. The parameters are row
 * contents: emails, tokens, whole JSON documents a data migration moves.
 * A unique violation during a migration or a request would copy them into
 * the pod log. This logger keeps the SQL text and the error, which is what
 * a failure is diagnosed from, and never passes the parameters on.
 *
 * Used by the app DataSource (app.module.ts) and the migration runner's
 * AppDataSource (database.config.ts).
 */
export class RedactedParametersQueryLogger extends AdvancedConsoleLogger {
  logQueryError(
    error: string,
    query: string,
    _parameters?: unknown,
    queryRunner?: QueryRunner,
  ): void {
    super.logQueryError(error, query, undefined, queryRunner);
  }

  logQuerySlow(time: number, query: string, _parameters?: unknown, queryRunner?: QueryRunner): void {
    super.logQuerySlow(time, query, undefined, queryRunner);
  }
}

/**
 * The app DataSource's logging: every query in development and nothing
 * otherwise, as before, but through the redacting logger. A logger
 * instance is used as-is by TypeORM, so it has to carry the levels itself.
 */
export function appQueryLogging(nodeEnv: string | undefined): {
  logging: LoggerOptions;
  logger: RedactedParametersQueryLogger;
} {
  const logging: LoggerOptions = nodeEnv === 'development';
  return { logging, logger: new RedactedParametersQueryLogger(logging) };
}
