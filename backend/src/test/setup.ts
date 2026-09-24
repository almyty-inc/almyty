// Global test setup
import { Test, TestingModule } from '@nestjs/testing';

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

// Mock external HTTP calls
export const mockAxios = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  patch: jest.fn(),
  request: jest.fn(),
};

jest.mock('axios', () => mockAxios);

// Mock Redis
export const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
  keys: jest.fn(),
  flushdb: jest.fn(),
};

jest.mock('redis', () => ({
  createClient: () => mockRedis,
}));

// Mock JWT
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mock-jwt-token'),
  verify: jest.fn(() => ({ sub: 'user-id', username: 'test-user' })),
}));

// Mock bcryptjs
jest.mock('bcryptjs', () => ({
  hash: jest.fn(() => Promise.resolve('hashed-password')),
  compare: jest.fn(() => Promise.resolve(true)),
}));

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
    Object.values(mockAxios).forEach(mock => mock.mockReset());
    Object.values(mockRedis).forEach(mock => mock.mockReset());
  }
}

// Setup and teardown
beforeEach(() => {
  TestHelper.resetAllMocks();
});

afterAll(async () => {
  // Clean up any global resources
});