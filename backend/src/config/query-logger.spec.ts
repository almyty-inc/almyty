import { readFileSync } from 'fs';
import { join } from 'path';
import { AdvancedConsoleLogger } from 'typeorm';

import { appQueryLogging, RedactedParametersQueryLogger } from './query-logger';

/**
 * A failing query reaches the log through TypeORM's logger, which appends
 * `-- PARAMETERS: [...]`: the row being written. These pin that the app
 * DataSource's logger keeps the SQL and the error and drops the parameters.
 * (The migration runner's logger is pinned in migration-logging.spec.ts.)
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

describe('app DataSource query logging', () => {
  let printed: string[];
  let spies: jest.SpyInstance[];

  beforeEach(() => {
    printed = [];
    spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(' '));
      }),
    );
  });

  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  const out = () => printed.join('\n').replace(ANSI, '');

  const failInsert = (logger: { logQueryError: AdvancedConsoleLogger['logQueryError'] }) =>
    logger.logQueryError(
      'duplicate key value violates unique constraint "UQ_users_email"',
      'INSERT INTO "users" ("email", "passwordHash") VALUES ($1, $2)',
      ['alice@example.com', '$2b$10$row-contents'],
    );

  it('the stock TypeORM logger prints the failing query parameters', () => {
    failInsert(new AdvancedConsoleLogger(true));
    expect(out()).toContain('alice@example.com');
  });

  it('in development logs a failing query with its SQL and error, not its parameters', () => {
    const { logging, logger } = appQueryLogging('development');
    expect(logging).toBe(true);
    expect(logger).toBeInstanceOf(RedactedParametersQueryLogger);

    failInsert(logger);
    logger.logQuerySlow(2000, 'SELECT * FROM "credentials" WHERE "value" = $1', ['sk-row-contents']);

    expect(out()).toContain('INSERT INTO "users" ("email", "passwordHash") VALUES ($1, $2)');
    expect(out()).toContain('violates unique constraint "UQ_users_email"');
    expect(out()).toContain('SELECT * FROM "credentials"');
    expect(out()).not.toContain('alice@example.com');
    expect(out()).not.toContain('row-contents');
    expect(out()).not.toContain('PARAMETERS');
  });

  it('outside development keeps query logging off', () => {
    const { logging, logger } = appQueryLogging('production');
    expect(logging).toBe(false);

    failInsert(logger);
    expect(out()).toBe('');
  });

  it('is the logger the app TypeORM module is configured with', () => {
    const source = readFileSync(join(__dirname, '..', 'app.module.ts'), 'utf8');
    const factory = source.slice(source.indexOf('TypeOrmModule.forRootAsync'));
    expect(factory).toMatch(/\.\.\.appQueryLogging\(configService\.get<string>\('NODE_ENV'\)\)/);
    expect(factory.slice(0, factory.indexOf('TypeOrmModule.forFeature'))).not.toMatch(/\blogging:/);
  });
});
