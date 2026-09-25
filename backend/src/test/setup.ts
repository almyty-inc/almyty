// Global test setup

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

// Mock console methods to keep tests quiet
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
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

// No shared repository, DataSource or TestingModule doubles live here. The
// ones that did answered every query-builder call with `this` and every read
// with `undefined`, so a spec built on them passed whatever SQL the code
// under test composed. Specs use src/test/fake-repository.ts and friends.
// Pinned by __tests__/no-shared-match-anything-doubles.spec.ts.

beforeEach(() => {
  jest.clearAllMocks();
});

export {};
