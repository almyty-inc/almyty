/**
 * Standalone migration runner.
 * Run via: node dist/run-migrations.js
 * Or via K8s Job: kubectl apply -f k8s/base/migration-job.yaml
 *
 * Uses TypeORM synchronize to create/update schema.
 * For production, consider switching to proper TypeORM migrations.
 */
import { DataSource } from 'typeorm';
import * as path from 'path';

async function runMigrations() {
  console.log('Starting database migration...');

  const dbSsl = process.env.DB_SSL === 'true';

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'password',
    database: process.env.DATABASE_NAME || 'almyty',
    ssl: dbSsl ? { rejectUnauthorized: false } : false,
    entities: [path.join(__dirname, 'entities', '*.entity.{ts,js}')],
    synchronize: true, // Creates/updates tables to match entities
    logging: true,
  });

  try {
    await dataSource.initialize();
    console.log('Database connection established.');
    console.log('Schema synchronized successfully.');

    // Log table info
    const queryRunner = dataSource.createQueryRunner();
    const tables = await queryRunner.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    console.log(`Tables in database: ${tables.length}`);
    for (const t of tables) {
      console.log(`  - ${t.tablename}`);
    }
    await queryRunner.release();

    await dataSource.destroy();
    console.log('Migration complete.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
