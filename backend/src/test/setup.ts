// Global test setup
import { Test, TestingModule } from '@nestjs/testing';
import { assertExtensionsInPublic } from './integration/test-db-extensions';

// The integration specs boot a real Nest graph and run every migration in
// their own Postgres schema before the first assertion. That does not finish
// in jest's default 5000ms, so their beforeAll hooks were racing a timeout on
// every run -- which is why integration failures here look intermittent and
// unrelated to the code, and why a green local run says little. Unit tests
// keep the fast default: a unit test that needs sixty seconds is a defect in
// the test.
if (process.env.RUN_DB_INTEGRATION === '1') {
  jest.setTimeout(120_000);
}

// After every DB-integration spec file, the extensions the migrations need
// must still be in `public`. A spec that let its migrations create one in
// its own schema fails here, by name, rather than some later spec failing
// with "function uuid_generate_v4() does not exist".
if (process.env.RUN_DB_INTEGRATION === '1') {
  afterAll(async () => {
    const specPath = expect.getState().testPath ?? '';
    if (!/[\\/]test[\\/]integration[\\/]/.test(specPath)) return;
    await assertExtensionsInPublic(specPath);
  });
}
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

// Mock console methods to keep tests quiet
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Mock entities for testing
export const mockRepository = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findOneBy: jest.fn(),
  findAndCount: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
  delete: jest.fn(),
  update: jest.fn(),
  create: jest.fn(),
  count: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
    getOne: jest.fn(),
    getManyAndCount: jest.fn(),
    execute: jest.fn(),
  })),
});

// Mock DataSource
export const mockDataSource = () => ({
  createQueryRunner: jest.fn(() => ({
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      save: jest.fn(),
      remove: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
    },
  })),
  manager: {
    save: jest.fn(),
    remove: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    transaction: jest.fn(),
  },
});

// Helper to create mock providers for entities
export const createMockProviders = (entities: any[]) => {
  return entities.map(entity => ({
    provide: getRepositoryToken(entity),
    useFactory: mockRepository,
  }));
};

// axios and redis stay real here too. The global doubles they replaced
// answered every HTTP call and every redis command with `undefined`: a spec
// could reach a real outbound request or a redis read without knowing it,
// and pass, and a spec that declared its own axios mock silently got this
// file's double instead of the one it asked for. A spec that needs HTTP
// stubbed mocks axios itself or spies on the method it expects; one that
// needs redis uses src/test/fake-redis.ts.
// Pinned by __tests__/no-global-http-redis-doubles.spec.ts.

// bcrypt and bcryptjs stay real here: a global double that says every
// password matches makes every wrong-password path untestable. Specs that
// want speed hash with a low cost factor (hash(pw, 4)); a spec that wants a
// double declares its own jest.mock. Pinned by
// __tests__/no-global-bcrypt-stub.spec.ts.

// jsonwebtoken stays real for the same reason: a global double whose verify
// returned a fixed payload for any string let forged, expired and
// wrong-secret tokens through every real JwtService in the suite. Specs sign
// real tokens with src/test/jwt.ts. Pinned by
// __tests__/no-global-jwt-stub.spec.ts.

// Global test helpers
export class TestHelper {
  static async createTestingModule(providers: any[] = []): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [
        {
          provide: DataSource,
          useFactory: mockDataSource,
        },
        ...providers,
      ],
    }).compile();
  }

  static mockEntity<T>(entity: new () => T, data: Partial<T>): T {
    const instance = new entity();
    Object.assign(instance, data);
    return instance;
  }

  static resetAllMocks() {
    jest.clearAllMocks();
  }
}

// Setup and teardown
beforeEach(() => {
  TestHelper.resetAllMocks();
});

afterAll(async () => {
  // Clean up any global resources
});