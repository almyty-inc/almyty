import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Shared spies for the mocked posthog-js default export. Declared before
// the vi.mock factory so the factory can close over them (hoisting-safe
// because vi.mock is hoisted above imports and we reference lazily).
const posthogMock = {
  init: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
}

vi.mock('posthog-js', () => ({
  default: posthogMock,
}))

// Import the module fresh in each test so `client`/`initStarted` module
// state resets. We use dynamic import + resetModules for isolation.
async function loadAnalytics() {
  return await import('../analytics')
}

describe('analytics wrapper — no key (disabled)', () => {
  beforeEach(() => {
    vi.resetModules()
    posthogMock.init.mockClear()
    posthogMock.identify.mockClear()
    posthogMock.reset.mockClear()
    posthogMock.capture.mockClear()
    vi.stubEnv('VITE_POSTHOG_KEY', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('initAnalytics does not load or init posthog when key is unset', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    expect(posthogMock.init).not.toHaveBeenCalled()
  })

  it('identify/capture/reset are safe no-ops when uninitialized', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    expect(() => a.identifyUser({ id: 'u1', orgId: 'o1', plan: 'pro' })).not.toThrow()
    expect(() => a.captureEvent('agent_created')).not.toThrow()
    expect(() => a.resetAnalytics()).not.toThrow()
    expect(posthogMock.identify).not.toHaveBeenCalled()
    expect(posthogMock.capture).not.toHaveBeenCalled()
    expect(posthogMock.reset).not.toHaveBeenCalled()
  })
})

describe('analytics wrapper — keyed (enabled)', () => {
  beforeEach(() => {
    vi.resetModules()
    posthogMock.init.mockClear()
    posthogMock.identify.mockClear()
    posthogMock.reset.mockClear()
    posthogMock.capture.mockClear()
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test_key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('inits pointing at the same-origin /ingest proxy by default', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    expect(posthogMock.init).toHaveBeenCalledTimes(1)
    const [key, opts] = posthogMock.init.mock.calls[0]
    expect(key).toBe('phc_test_key')
    // Events go through the same-origin proxy (ad-blocker safe)...
    expect(opts.api_host).toBe('/ingest')
    // ...while the toolbar/session links still resolve to real PostHog.
    expect(opts.ui_host).toBe('https://eu.posthog.com')
  })

  it('keeps cookieless + identified_only + autocapture posture', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    const opts = posthogMock.init.mock.calls[0][1]
    expect(opts.persistence).toBe('memory')
    expect(opts.person_profiles).toBe('identified_only')
    expect(opts.autocapture).toBe(true)
  })

  it('disables automatic pageview (SPA captures are manual)', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    expect(posthogMock.init.mock.calls[0][1].capture_pageview).toBe(false)
  })

  it('honors VITE_POSTHOG_HOST override (aligned proxy origin)', async () => {
    vi.stubEnv('VITE_POSTHOG_HOST', 'https://app.almyty.com/ingest')
    const a = await loadAnalytics()
    await a.initAnalytics()
    expect(posthogMock.init.mock.calls[0][1].api_host).toBe('https://app.almyty.com/ingest')
  })

  it('capturePageview forwards a $pageview with $current_url', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    a.capturePageview('/agents/42?tab=runs')
    expect(posthogMock.capture).toHaveBeenCalledTimes(1)
    const [event, props] = posthogMock.capture.mock.calls[0]
    expect(event).toBe('$pageview')
    expect(props.$current_url).toContain('/agents/42?tab=runs')
  })

  it('capturePageview is a no-op when analytics is disabled', async () => {
    vi.stubEnv('VITE_POSTHOG_KEY', '')
    const a = await loadAnalytics()
    await a.initAnalytics()
    a.capturePageview('/anything')
    expect(posthogMock.capture).not.toHaveBeenCalled()
  })

  it('init is idempotent (second call is a no-op)', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    await a.initAnalytics()
    expect(posthogMock.init).toHaveBeenCalledTimes(1)
  })

  it('identifyUser passes id and org/plan traits', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    a.identifyUser({ id: 'user-1', orgId: 'org-9', plan: 'pro' })
    expect(posthogMock.identify).toHaveBeenCalledWith('user-1', { orgId: 'org-9', plan: 'pro' })
  })

  it('identifyUser omits absent traits and skips when id missing', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    a.identifyUser({ id: 'user-2' })
    expect(posthogMock.identify).toHaveBeenCalledWith('user-2', {})
    posthogMock.identify.mockClear()
    a.identifyUser({ id: '' })
    expect(posthogMock.identify).not.toHaveBeenCalled()
  })

  it('resetAnalytics forwards to posthog.reset (logout)', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    a.resetAnalytics()
    expect(posthogMock.reset).toHaveBeenCalledTimes(1)
  })

  it('captureEvent forwards name and props', async () => {
    const a = await loadAnalytics()
    await a.initAnalytics()
    a.captureEvent('gateway_deployed', { channelType: 'slack' })
    expect(posthogMock.capture).toHaveBeenCalledWith('gateway_deployed', { channelType: 'slack' })
  })
})
