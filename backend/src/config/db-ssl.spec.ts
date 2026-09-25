import { ConfigService } from '@nestjs/config';

import { snapshotEnv } from '../test/env';
import { appTypeOrmOptions } from './app-typeorm.options';
import { dbSslOption } from './db-ssl';

/**
 * DB_SSL alone decides whether Postgres is reached over TLS, for the app
 * (AppModule's TypeORM options) and for the typeorm CLI the db-migration job
 * runs (database.config.ts). The CLI used to key it off NODE_ENV instead, so
 * a production-mode job against a plain local database demanded TLS, and a
 * non-production job against a managed one went without it.
 */
const TLS = { rejectUnauthorized: false };

/** AppDataSource as the migration CLI loads it, built from the current env. */
function migrationCliSsl(): unknown {
  let ssl: unknown;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ssl = require('./database.config').AppDataSource.options.ssl;
  });
  return ssl;
}

function appOptions() {
  return appTypeOrmOptions(new ConfigService());
}

describe('Postgres TLS follows DB_SSL', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotEnv('DB_SSL', 'NODE_ENV');
  });
  afterEach(() => restore());

  const cases: Array<{ DB_SSL?: string; NODE_ENV: string; tls: boolean }> = [
    { DB_SSL: 'true', NODE_ENV: 'development', tls: true },
    { DB_SSL: 'true', NODE_ENV: 'production', tls: true },
    { DB_SSL: 'false', NODE_ENV: 'production', tls: false },
    { DB_SSL: undefined, NODE_ENV: 'production', tls: false },
    { DB_SSL: undefined, NODE_ENV: 'test', tls: false },
  ];

  it.each(cases)('DB_SSL=$DB_SSL NODE_ENV=$NODE_ENV -> tls $tls, app and migration CLI alike', (c) => {
    if (c.DB_SSL === undefined) delete process.env.DB_SSL;
    else process.env.DB_SSL = c.DB_SSL;
    process.env.NODE_ENV = c.NODE_ENV;

    const expected = c.tls ? TLS : false;
    expect(migrationCliSsl()).toEqual(expected);

    const app = appOptions();
    expect(app.ssl).toEqual(expected);
    // The pg driver reads the pool's own copy too.
    expect(app.extra.ssl).toEqual(c.tls ? TLS : undefined);
  });

  it('the helper reads DB_SSL only', () => {
    const read: string[] = [];
    const get = (key: string) => {
      read.push(key);
      return key === 'NODE_ENV' ? 'production' : undefined;
    };
    expect(dbSslOption(get)).toBe(false);
    expect(read).toEqual(['DB_SSL']);
    expect(dbSslOption((key) => (key === 'DB_SSL' ? 'true' : undefined))).toEqual(TLS);
  });
});
