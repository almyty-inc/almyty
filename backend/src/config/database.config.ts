import { AdvancedConsoleLogger, DataSource, LoggerOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { versionsConfig } from 'typeorm-versions';

// Load environment variables
config();

const configService = new ConfigService();

// AppDataSource is what the typeorm CLI loads (the db-migration job and the
// typeorm:migration:* scripts). The CLI overrides `logging` with a list that
// includes "query" before it connects, which would print every migration
// statement with its bound parameters -- whole rows for data migrations --
// into the job's pod log. A logger instance is used as-is by typeorm and
// ignores that override, so it pins the levels: migration names and progress
// (schema), migration failures (migration), and errors and warnings.
export const MIGRATION_LOG_LEVELS: LoggerOptions = ['error', 'warn', 'migration', 'schema'];

export const AppDataSource = new DataSource(versionsConfig({
  type: 'postgres',
  host: configService.get('DATABASE_HOST', 'localhost'),
  port: configService.get('DATABASE_PORT', 5433),
  username: configService.get('DATABASE_USERNAME', 'postgres'),
  password: configService.get('DATABASE_PASSWORD', 'password'),
  database: configService.get('DATABASE_NAME', 'almyty'),
  entities: [__dirname + '/../entities/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../migrations/*{.ts,.js}'],
  synchronize: false,
  logging: MIGRATION_LOG_LEVELS,
  logger: new AdvancedConsoleLogger(MIGRATION_LOG_LEVELS),
  ssl: configService.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
}) as any);

// Database configuration for NestJS - Using PostgreSQL
export const databaseConfig = {
  type: 'postgres' as const,
  host: configService.get('DATABASE_HOST', 'localhost'),
  port: configService.get('DATABASE_PORT', 5433),
  username: configService.get('DATABASE_USERNAME', 'postgres'),
  password: configService.get('DATABASE_PASSWORD', 'password'),
  database: configService.get('DATABASE_NAME', 'almyty'),
  entities: [__dirname + '/../entities/*.entity{.ts,.js}'],
  synchronize: false,
  logging: configService.get('NODE_ENV') === 'development',
  autoLoadEntities: true,
  ssl: configService.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
};