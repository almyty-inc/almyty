import { ArgumentsHost } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, QueryFailedError } from 'typeorm';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PlatformTools } = require('typeorm/platform/PlatformTools.js');
import { inspect } from 'util';

import { appDataSourceFactory } from '../../common/errors/redact-query-error';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import { CorrelatedConsoleLogger } from '../../common/logging/correlated-console.logger';
import { sentryInitOptions } from '../../common/observability/sentry-options';
import { AppDataSource } from '../../config/database.config';
import { testDbConnection } from './test-db-extensions';

/**
 * A failed query's error, from a real Postgres, printed every way the
 * backend prints one: the typeorm CLI's `console.error(err)` when a
 * migration fails, Nest's logger handed the error object, the global
 * exception filter, and a Sentry event (with the console breadcrumb that
 * precedes it). None of them may carry the row the statement was writing:
 * its bound parameters, or the `detail` Postgres attaches to a unique
 * violation.
 */
const describeIfDb = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const SCHEMA = 'query_error_redaction';
const SECRET = 'alice.row-contents@example.com';

function connectionOptions() {
  const c = testDbConnection();
  return {
    type: 'postgres' as const,
    host: c.host,
    port: c.port,
    username: c.user,
    password: c.password,
    database: c.database,
  };
}

async function failingInsert(run: (sql: string, params: unknown[]) => Promise<unknown>): Promise<any> {
  try {
    await run(`INSERT INTO ${SCHEMA}.people (email) VALUES ($1)`, [SECRET]);
  } catch (error) {
    return error;
  }
  throw new Error('the insert was expected to violate the unique index');
}

/** Everything written to stdout, stderr and the console while `fn` runs. */
async function capturePrinted(fn: () => unknown): Promise<string> {
  const out: string[] = [];
  const record = (...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 10 }))).join(' '));
    return true;
  };
  const spies = [
    jest.spyOn(process.stdout, 'write').mockImplementation(record as any),
    jest.spyOn(process.stderr, 'write').mockImplementation(record as any),
    ...(['log', 'info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(record),
    ),
  ];
  try {
    await fn();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
  return out.join('\n');
}

function httpHost(): ArgumentsHost {
  const response: any = { status: () => response, json: () => response, setHeader: () => undefined };
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', path: '/people', headers: {} }),
    }),
  } as unknown as ArgumentsHost;
}

describeIfDb('a failed query does not carry its row out (real Postgres)', () => {
  beforeAll(async () => {
    const admin = new Client(testDbConnection());
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      await admin.query(`CREATE TABLE ${SCHEMA}.people (id serial PRIMARY KEY, email text NOT NULL UNIQUE)`);
      await admin.query(`INSERT INTO ${SCHEMA}.people (email) VALUES ($1)`, [SECRET]);
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    const admin = new Client(testDbConnection());
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  describe('the app DataSource (app.module.ts builds it with appDataSourceFactory)', () => {
    let dataSource: DataSource;
    let error: any;

    beforeAll(async () => {
      dataSource = await appDataSourceFactory(connectionOptions()).initialize();
      error = await failingInsert((sql, params) => dataSource.query(sql, params as any[]));
    });

    afterAll(async () => {
      await dataSource?.destroy();
    });

    it('fails the way Postgres failed, with what code branches on still there', () => {
      expect(error).toBeInstanceOf(QueryFailedError);
      expect(error.code).toBe('23505');
      expect(error.constraint).toBe('people_email_key');
      expect(error.message).toContain('duplicate key value violates unique constraint');
      expect(error.query).toContain(`INSERT INTO ${SCHEMA}.people`);
    });

    it('holds neither the parameters nor the detail naming the row', () => {
      expect(inspect(error, { depth: 10 })).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    });

    it('fails the same way through a repository-style query runner', async () => {
      const runner = dataSource.createQueryRunner();
      try {
        const viaRunner = await failingInsert((sql, params) => runner.query(sql, params as any[]));
        expect(viaRunner.code).toBe('23505');
        expect(inspect(viaRunner, { depth: 10 })).not.toContain(SECRET);
      } finally {
        await runner.release();
      }
    });
  });

  describe('the typeorm CLI data source (database.config.ts, the db-migration job)', () => {
    beforeAll(async () => {
      AppDataSource.setOptions(connectionOptions());
      await AppDataSource.initialize();
    });

    afterAll(async () => {
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
    });

    it('prints a failing migration statement without its row', async () => {
      // What a migration does: queryRunner.query inside up().
      const runner = AppDataSource.createQueryRunner();
      let error: any;
      try {
        error = await failingInsert((sql, params) => runner.query(sql, params as any[]));
      } finally {
        await runner.release();
      }
      // What MigrationRunCommand does with it.
      const printed = await capturePrinted(() => PlatformTools.logCmdErr('Error during migration run:', error));
      expect(printed).toContain('duplicate key value');
      expect(printed).not.toContain(SECRET);
    });
  });

  describe('an error from a DataSource built some other way', () => {
    let raw: DataSource;

    async function rawError(): Promise<any> {
      return failingInsert((sql, params) => raw.query(sql, params as any[]));
    }

    beforeAll(async () => {
      raw = await new DataSource(connectionOptions()).initialize();
    });

    afterAll(async () => {
      await raw?.destroy();
    });

    it('carries the row, which is why every printer redacts too', async () => {
      expect(inspect(await rawError(), { depth: 10 })).toContain(SECRET);
    });

    it("is printed without the row by Nest's logger handed the error object", async () => {
      const error = await rawError();
      const logger = new CorrelatedConsoleLogger();
      const printed = await capturePrinted(() => logger.error(error, undefined, 'Worker'));
      expect(printed).toContain('duplicate key value');
      expect(printed).not.toContain(SECRET);
    });

    it('is left without the row by the global exception filter', async () => {
      const error = await rawError();
      const printed = await capturePrinted(() => new GlobalExceptionFilter().catch(error, httpHost()));
      expect(printed).not.toContain(SECRET);
      expect(inspect(error, { depth: 10 })).not.toContain(SECRET);
    });

    it('reaches Sentry without the row, in the event or the console breadcrumb before it', async () => {
      const Sentry = require('@sentry/node');
      const sent: string[] = [];
      const options = sentryInitOptions({ SENTRY_DSN: 'https://public@sentry.invalid/1' });
      expect(options).not.toBeNull();
      Sentry.init({
        ...options,
        beforeSend: (event: any, hint: any) => {
          sent.push(JSON.stringify(options!.beforeSend ? options!.beforeSend(event, hint) : event));
          return null;
        },
      });
      try {
        const error = await rawError();
        // Some code logs the error with console.error before it surfaces.
        console.error('import failed', error);
        Sentry.captureException(error);
        await Sentry.flush(2000);
      } finally {
        await Sentry.close(2000);
      }
      expect(sent.length).toBe(1);
      expect(sent[0]).toContain('duplicate key value');
      expect(sent[0]).not.toContain(SECRET);
    });
  });
});
