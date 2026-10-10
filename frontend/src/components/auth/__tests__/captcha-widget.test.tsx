import React from 'react'
import { render, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/**
 * The widget mounts twice under React's StrictMode (every dev page). The
 * second mount found the <script> tag the first had added, treated it as
 * loaded, saw no `window.turnstile` yet and gave up, so in dev the captcha
 * never rendered and the sign-up form could not be submitted.
 */
describe('CaptchaWidget', () => {
  let renderSpy: ReturnType<typeof vi.fn>
  let removeSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('ALMYTY_TURNSTILE_SITE_KEY', '1x00000000000000000000AA')
    renderSpy = vi.fn(() => 'widget-1')
    removeSpy = vi.fn()
    document.head.querySelectorAll('script').forEach((s) => s.remove())
    delete (window as any).turnstile
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
    delete (window as any).turnstile
  })

  /** Finish loading the provider script: the tag fires onload, and the global appears a little later. */
  function finishScriptLoad() {
    const tag = document.head.querySelector(`script[src="${SRC}"]`) as HTMLScriptElement | null
    expect(tag).not.toBeNull()
    tag!.onload?.(new Event('load'))
    setTimeout(() => {
      ;(window as any).turnstile = { render: renderSpy, remove: removeSpy }
    }, 150)
  }

  it('renders the provider widget once under StrictMode, after the script has loaded', async () => {
    const { CaptchaWidget } = await import('../captcha-widget')
    const onToken = vi.fn()
    render(
      <React.StrictMode>
        <CaptchaWidget onToken={onToken} />
      </React.StrictMode>,
    )

    expect(document.head.querySelectorAll(`script[src="${SRC}"]`)).toHaveLength(1)
    finishScriptLoad()

    await waitFor(() => expect(renderSpy).toHaveBeenCalledTimes(1))
    const [container, options] = renderSpy.mock.calls[0] as unknown as [HTMLElement, any]
    expect(container.getAttribute('data-testid')).toBe('captcha-widget')
    expect(options.sitekey).toBe('1x00000000000000000000AA')

    options.callback('token-abc')
    expect(onToken).toHaveBeenCalledWith('token-abc')
  })

  it('removes the widget it rendered on unmount', async () => {
    const { CaptchaWidget } = await import('../captcha-widget')
    const { unmount } = render(<CaptchaWidget onToken={vi.fn()} />)
    finishScriptLoad()
    await waitFor(() => expect(renderSpy).toHaveBeenCalledTimes(1))

    unmount()
    expect(removeSpy).toHaveBeenCalledWith('widget-1')
  })

  it('renders nothing without a site key', async () => {
    vi.stubEnv('ALMYTY_TURNSTILE_SITE_KEY', '')
    const { CaptchaWidget, isCaptchaEnabled } = await import('../captcha-widget')
    const { container } = render(<CaptchaWidget onToken={vi.fn()} />)
    expect(isCaptchaEnabled()).toBe(false)
    expect(container.innerHTML).toBe('')
    expect(document.head.querySelector(`script[src="${SRC}"]`)).toBeNull()
  })
})
