import { ConfigService } from '@nestjs/config';
import { versionsConfig } from 'typeorm-versions';

import { CustomVersionSubscriber } from '../common/custom-version-subscriber';
import { dbSslOption } from './db-ssl';
import { appQueryLogging } from './query-logger';

/**
 * The app's TypeORM options (AppModule's TypeOrmModule.forRootAsync
 * factory). Individual connection params, not a URL, so SSL stays under
 * DB_SSL's control -- the same helper database.config.ts (the migration CLI)
 * uses, so the two cannot disagree about TLS.
 */
export function appTypeOrmOptions(configService: ConfigService) {
  const ssl = dbSslOption((key) => configService.get<string>(key));

  const config = versionsConfig({
    type: 'postgres' as const,
    host: configService.get<string>('DATABASE_HOST', 'localhost'),
    port: parseInt(configService.get<string>('DATABASE_PORT', '5432')),
    username: configService.get<string>('DATABASE_USERNAME', 'postgres'),
    password: configService.get<string>('DATABASE_PASSWORD', 'password'),
    database: configService.get<string>('DATABASE_NAME', 'almyty'),
    entities: [__dirname + '/../entities/*.entity{.ts,.js}'],
    migrations: [__dirname + '/../migrations/*{.ts,.js}'],
    // Pods migrate on boot only when explicitly enabled (the local
    // default). In the cluster DB_MIGRATIONS_RUN=false: a single
    // gated migration Job runs before the rollout, so the N replicas
    // don't race each other running the same migrations on startup.
    migrationsRun: configService.get('DB_MIGRATIONS_RUN', 'true') !== 'false',
    synchronize: false,
    // Failing and slow queries are logged with their SQL and error,
    // never their parameters (row contents).
    ...appQueryLogging(configService.get<string>('NODE_ENV')),
    ssl,
    extra: {
      // Default pool 10 → 30. Tool generation now batches 20
      // saves in flight per import (was 5); 30 gives the
      // import worker its full batch + spare connections for
      // the rest of the app's concurrent request handling.
      // Postgres default max_connections is 100; one pod
      // taking 30 leaves plenty for sibling pods + admin.
      max: parseInt(configService.get<string>('DB_POOL_SIZE', '30')),
      ...(ssl && { ssl }),
    },
  });
  // Replace default subscriber with our custom one that tracks the user
  (config as any).subscribers = [CustomVersionSubscriber];
  return {
    ...config,
    autoLoadEntities: true,
  } as any;
}
