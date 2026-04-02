import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { versionsConfig } from 'typeorm-versions';

// Load environment variables
config();

const configService = new ConfigService();

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
  logging: configService.get('NODE_ENV') === 'development',
  ssl: configService.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
}));

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