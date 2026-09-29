import { readFileSync } from 'fs';

import { AppDataSource } from './database.config';

/**
 * The db-migration job (k8s/base/migration-job.yaml) runs
 * `typeorm migration:run -d dist-ee/src/config/database.config.js`. The
 * typeorm CLI does not honour the data source's own `logging`: before
 * initialize it calls setOptions({ logging: [...] }) with a list that
 * includes "query", so every statement a migration runs, with its bound
 * parameters (whole rows for data migrations), lands in the pod log.
 *
 * This replays exactly what the installed CLI does to AppDataSource and then
 * checks what its logger actually prints.
 */
function cliLoggingOverride(): unknown[] {
  const cliSource = readFileSync(
    require.resolve('typeorm/commands/MigrationRunCommand.js'),
    'utf8',
  );
  const match = cliSource.match(/setOptions\(\{[\s\S]*?logging:\s*(\[[^\]]*\])/);
  if (!match) {
    throw new Error('typeorm migration:run no longer overrides logging; revisit this spec');
  }
  return JSON.parse(match[1]);
}

describe('migration runner logging', () => {
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

  it('the CLI still forces query logging on the data source it loads', () => {
    expect(cliLoggingOverride()).toContain('query');
  });

  it('does not print migration SQL or its parameters after the CLI override', () => {
    AppDataSource.setOptions({ logging: cliLoggingOverride() as any });

    AppDataSource.logger.logQuery(
      'INSERT INTO "versions" ("object") VALUES ($1)',
      ['{"secret":"row-contents"}'],
    );

    expect(printed.join('\n')).not.toContain('row-contents');
    expect(printed.join('\n')).not.toContain('INSERT INTO');
  });

  it('still prints migration names and errors', () => {
    AppDataSource.setOptions({ logging: cliLoggingOverride() as any });

    AppDataSource.logger.logSchemaBuild('Migration AddWidgets1700000000000 has been executed successfully.');
    AppDataSource.logger.logMigration('Migration "AddWidgets1700000000000" failed, error: boom');
    AppDataSource.logger.logQueryError('relation "widgets" does not exist', 'SELECT 1', []);

    const out = printed.join('\n');
    expect(out).toContain('AddWidgets1700000000000 has been executed successfully');
    expect(out).toContain('failed, error: boom');
    expect(out).toContain('relation "widgets" does not exist');
  });

  it('logs a failing migration query with its SQL and error but not its parameters', () => {
    AppDataSource.setOptions({ logging: cliLoggingOverride() as any });

    AppDataSource.logger.logQueryError(
      'duplicate key value violates unique constraint "UQ_users_email"',
      'UPDATE "users" SET "email" = $1 WHERE "id" = $2',
      ['alice@example.com', 'row-secret-id'],
    );
    AppDataSource.logger.logQuerySlow(
      2500,
      'SELECT * FROM "credentials" WHERE "value" = $1',
      ['sk-live-row-contents'],
    );

    // The console logger highlights SQL with ANSI colour codes.
    // eslint-disable-next-line no-control-regex
    const out = printed.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
    expect(out).toContain('UPDATE "users" SET "email" = $1');
    expect(out).toContain('violates unique constraint');
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('row-secret-id');
    expect(out).not.toContain('sk-live-row-contents');
  });
});

describe('database.config.ts', () => {
  // The app's DataSource is built in app.module.ts; this file is only the
  // typeorm CLI's. A second, unused config here (it had its own `logging`
  // and ssl rules) drifted from both without anything noticing.
  it('exports the CLI data source and its log levels, nothing else', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(Object.keys(require('./database.config')).sort()).toEqual(['AppDataSource', 'MIGRATION_LOG_LEVELS']);
  });
});
