import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const posthogMock = {
  init: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
  register: vi.fn(),
  startSessionRecording: vi.fn(),
}

vi.mock('posthog-js', () => ({ default: posthogMock }))

/**
 * Session replay is ON in production (disable_session_recording is lifted by
 * startRecordingOnLoad), and `maskAllInputs` covers only the VALUES of
 * <input>/<textarea>/<select>. rrweb captures every other text node
 * verbatim.
 *
 * The one-time personal API key in Settings is rendered as page text in a
 * <code> block, not an input — so before this, minting a key in production
 * uploaded it in the clear to a third-party analytics vendor, where it sits
 * in a replay anyone with PostHog access can scrub to.
 *
 * The contract: a `maskTextSelector` is configured, and every element that
 * renders a live secret as text carries the matching attribute.
 */
describe('session replay never records a secret rendered as text', () => {
  beforeEach(() => {
    vi.resetModules()
    posthogMock.init.mockClear()
    vi.stubEnv('ALMYTY_POSTHOG_KEY', 'phc_test_key')
    vi.stubEnv('ALMYTY_APP_ENV', 'production')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('configures a maskTextSelector alongside maskAllInputs', async () => {
    const analytics = await import('../analytics')
    await analytics.initAnalytics()

    expect(posthogMock.init).toHaveBeenCalledTimes(1)
    const options = posthogMock.init.mock.calls[0][1]
    expect(options.session_recording.maskAllInputs).toBe(true)
    expect(options.session_recording.maskTextSelector).toBe(analytics.SENSITIVE_TEXT_SELECTOR)
    expect(analytics.SENSITIVE_TEXT_SELECTOR).toBe(`[${analytics.SENSITIVE_TEXT_ATTRIBUTE}]`)
  })

  /**
   * A source-reading guard rather than a render test: the page mints the key
   * through a mutation and the point is that the element bearing it is
   * marked at all, wherever it moves to in the file. Rendering the dialog
   * would prove the same thing while breaking on any unrelated refactor of
   * the credentials page.
   */
  it('marks the one-time Settings API key as sensitive text', async () => {
    const { SENSITIVE_TEXT_ATTRIBUTE } = await import('../analytics')
    const source = readFileSync(resolve(__dirname, '../../components/settings/api-keys-settings.tsx'), 'utf8')

    const keyElement = source
      .split('\n')
      .find((line) => line.includes('{generatedKey}') && line.includes('<code'))

    expect(keyElement, 'the one-time key is no longer rendered in a <code> element').toBeDefined()
    expect(keyElement).toContain(SENSITIVE_TEXT_ATTRIBUTE)
  })
  it('masks a generated endpoint key before CopyField renders it as text', async () => {
    const { SENSITIVE_TEXT_ATTRIBUTE } = await import('../analytics')
    const source = readFileSync(resolve(__dirname, '../../components/gateways/detail/gateway-auth-section.tsx'), 'utf8')
    const keyContainer = source.split('\n').find((line) => line.includes('generated-api-key') && line.includes('<div'))
    expect(keyContainer).toBeDefined()
    expect(keyContainer).toContain(SENSITIVE_TEXT_ATTRIBUTE)
  })

})
