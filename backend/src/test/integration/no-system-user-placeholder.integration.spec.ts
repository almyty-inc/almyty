/**
 * 'system' is not a user id, and Postgres says so.
 *
 * Userless runs (a heartbeat, an A2A call, a hosted chat with no signed-in
 * user) handed `userId: run.userId || 'system'` to the tool executor, whose
 * first step is the caller's membership lookup:
 *
 *   userRepository.findOne({ where: { id: options.userId }, relations: { organizationMemberships: true } })
 *
 * `users.id` is a uuid column, so that query fails with
 * `invalid input syntax for type uuid: "system"` and every tool call of such
 * a run came back as that database error. A unit double that answers `null`
 * for an unknown id hides it, which is why this runs on real Postgres.
 *
 * The second half is a source check that the placeholder is gone from the
 * paths that feed tool execution and run creation.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';

import { User } from '../../entities/user.entity';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'no_system_user_test';

describeIfDb('a "system" user id against the real users table', () => {
  let ds: DataSource;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'password',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();
  }, 300_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await ds.destroy();
    }
  });

  it('the executor membership lookup rejects it outright', async () => {
    await expect(
      ds.getRepository(User).findOne({ where: { id: 'system' }, relations: { organizationMemberships: true } }),
    ).rejects.toThrow(/invalid input syntax for type uuid/);
  });
});

describe('no "system" placeholder reaches tool execution or run creation', () => {
  const SRC = join(__dirname, '..', '..');
  const FILES = [
    'modules/agents/agent-step-processor.ts',
    'modules/agents/agent-runtime.processor.ts',
    'modules/agents/agent-builtin-tools.helper.ts',
    'modules/agents/agent-scheduler.service.ts',
    'modules/llm-providers/llm-chat-runner.helper.ts',
    'modules/gateways/gateway-protocol.service.ts',
  ];

  it.each(FILES)('%s', (rel) => {
    const src = readFileSync(join(SRC, rel), 'utf8');
    // `userId: x || 'system'` / `?? 'system'`, or 'system' as a bare
    // startRun / execute argument.
    expect(src).not.toMatch(/(\|\||\?\?)\s*'system'/);
    expect(src).not.toMatch(/^\s*'system',\s*$/m);
  });
});

describe('no "system" creator on generated tools', () => {
  const SRC = join(__dirname, '..', '..');
  // Every place a tool or tool version is created by generation, and the
  // readers that used to match the sentinel.
  const FILES = [
    'modules/tools/tools-operation.helper.ts',
    'modules/tools/tool-generator.service.ts',
    'modules/apis/apis-tool-generator.helper.ts',
    'modules/apis/apis.service.ts',
    'modules/mcp-sources/mcp-sources.service.ts',
  ];

  it.each(FILES)('%s', (rel) => {
    const src = readFileSync(join(SRC, rel), 'utf8');
    expect(src).not.toMatch(/createdBy['"]?\s*[:=]\s*'system'/);
    expect(src).not.toMatch(/createToolVersion\([^)]*'system'\)/);
  });
});
