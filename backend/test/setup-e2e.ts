/**
 * E2E test setup — mock native modules that can't load in Jest
 * but let everything else (TypeORM, NestJS, bcrypt, jwt) run for real.
 */

// isolated-vm is a C++ native module that doesn't exist in worktrees / CI
jest.mock('isolated-vm', () => ({
  Isolate: jest.fn().mockImplementation(() => ({
    createContextSync: jest.fn().mockReturnValue({
      global: {
        setSync: jest.fn(),
        getSync: jest.fn(),
      },
      evalSync: jest.fn(),
      evalClosureSync: jest.fn(),
      release: jest.fn(),
    }),
    compileScriptSync: jest.fn().mockReturnValue({
      runSync: jest.fn(),
      release: jest.fn(),
    }),
    dispose: jest.fn(),
  })),
}));
