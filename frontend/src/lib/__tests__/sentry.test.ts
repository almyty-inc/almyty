import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Shared spies for the mocked @sentry/react module. Declared before the
// vi.mock factory so the factory can close over them (hoisting-safe).
const sentryMock = {
  init: vi.fn(),
  captureException: vi.fn(),
}

vi.mock('@sentry/react', () => sentryMock)

// Import the module fresh in each test so `client`/`initStarted` module
// state resets. Dynamic import + resetModules for isolation.
async function loadSentry() {
  return await import('../sentry')
}

describe('sentry wrapper — no DSN (disabled)', () => {
  beforeEach(() => {
    vi.resetModules()
    sentryMock.init.mockClear()
    sentryMock.captureException.mockClear()
    vi.stubEnv('VITE_SENTRY_DSN', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('initSentry does not load or init sentry when DSN is unset', async () => {
    const s = await loadSentry()
    await s.initSentry()
    expect(sentryMock.init).not.toHaveBeenCalled()
    expect(s.isSentryEnabled()).toBe(false)
  })

  it('captureError is a safe no-op when uninitialized', async () => {
    const s = await loadSentry()
    await s.initSentry()
    expect(() => s.captureError(new Error('boom'))).not.toThrow()
    expect(sentryMock.captureException).not.toHaveBeenCalled()
  })
})

describe('sentry wrapper — DSN set (enabled)', () => {
  beforeEach(() => {
    vi.resetModules()
    sentryMock.init.mockClear()
    sentryMock.captureException.mockClear()
    vi.stubEnv('VITE_SENTRY_DSN', 'https://public@o1.ingest.sentry.io/123')
    // Pin a tracked environment — jsdom's host is localhost, which the
    // wrapper (correctly) treats as development and would not track.
    vi.stubEnv('VITE_APP_ENV', 'production')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('inits with the DSN and resolved environment', async () => {
    const s = await loadSentry()
    await s.initSentry()
    expect(sentryMock.init).toHaveBeenCalledTimes(1)
    const opts = sentryMock.init.mock.calls[0][0]
    expect(opts.dsn).toBe('https://public@o1.ingest.sentry.io/123')
    expect(opts.environment).toBe('production')
    expect(s.isSentryEnabled()).toBe(true)
  })

  it('tags the environment super-property (staging vs production)', async () => {
    vi.stubEnv('VITE_APP_ENV', 'staging')
    const s = await loadSentry()
    await s.initSentry()
    expect(sentryMock.init.mock.calls[0][0].environment).toBe('staging')
  })

  it('init is idempotent (second call is a no-op)', async () => {
    const s = await loadSentry()
    await s.initSentry()
    await s.initSentry()
    expect(sentryMock.init).toHaveBeenCalledTimes(1)
  })

  it('captureError forwards to sentry.captureException once enabled', async () => {
    const s = await loadSentry()
    await s.initSentry()
    const err = new Error('render failed')
    s.captureError(err)
    expect(sentryMock.captureException).toHaveBeenCalledWith(err)
  })

  it('captureError ignores falsy input', async () => {
    const s = await loadSentry()
    await s.initSentry()
    s.captureError(null)
    expect(sentryMock.captureException).not.toHaveBeenCalled()
  })
})

describe('sentry wrapper — environment gating', () => {
  beforeEach(() => {
    vi.resetModules()
    sentryMock.init.mockClear()
    vi.stubEnv('VITE_SENTRY_DSN', 'https://public@o1.ingest.sentry.io/123')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does NOT track development (DSN set, but env is development)', async () => {
    vi.stubEnv('VITE_APP_ENV', 'development')
    const s = await loadSentry()
    await s.initSentry()
    expect(sentryMock.init).not.toHaveBeenCalled()
    expect(s.isSentryEnabled()).toBe(false)
  })

  it('defaults to development (untracked) for an unrecognized host', async () => {
    // No VITE_APP_ENV override; jsdom host is localhost -> development.
    const s = await loadSentry()
    await s.initSentry()
    expect(sentryMock.init).not.toHaveBeenCalled()
  })

  it('tracks staging and production', async () => {
    for (const env of ['staging', 'production'] as const) {
      vi.resetModules()
      sentryMock.init.mockClear()
      vi.stubEnv('VITE_APP_ENV', env)
      const s = await loadSentry()
      await s.initSentry()
      expect(sentryMock.init).toHaveBeenCalledTimes(1)
    }
  })
})
