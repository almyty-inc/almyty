import React from 'react'

/**
 * Optional CAPTCHA widget for the signup form.
 *
 * Renders ONLY when a public site key is configured via build-time env:
 *   ALMYTY_TURNSTILE_SITE_KEY  -> Cloudflare Turnstile
 *   ALMYTY_HCAPTCHA_SITE_KEY   -> hCaptcha
 *
 * When neither is set the component renders nothing and reports no token, so
 * the whole feature ships dark and matches the backend (which no-ops when
 * TURNSTILE_SECRET / HCAPTCHA_SECRET are unset). The provider script is loaded
 * lazily and only when a key exists.
 */

const TURNSTILE_KEY = import.meta.env.ALMYTY_TURNSTILE_SITE_KEY as string | undefined
const HCAPTCHA_KEY = import.meta.env.ALMYTY_HCAPTCHA_SITE_KEY as string | undefined

type Provider = 'turnstile' | 'hcaptcha'

function resolveProvider(): { provider: Provider; siteKey: string } | null {
  if (TURNSTILE_KEY) return { provider: 'turnstile', siteKey: TURNSTILE_KEY }
  if (HCAPTCHA_KEY) return { provider: 'hcaptcha', siteKey: HCAPTCHA_KEY }
  return null
}

/** True when a CAPTCHA is configured and should be enforced on the client. */
export function isCaptchaEnabled(): boolean {
  return resolveProvider() !== null
}

const SCRIPT_SRC: Record<Provider, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  hcaptcha: 'https://js.hcaptcha.com/1/api.js?render=explicit',
}

/**
 * One load per provider script, shared by every caller. Each caller waits
 * for the script itself, not just for its <script> tag: React's StrictMode
 * mounts the widget twice in dev, and the second mount used to find the tag
 * the first had added, resolve at once, see no global yet and give up, so
 * the widget never rendered and sign-up could not be submitted.
 */
const scriptLoads = new Map<Provider, Promise<void>>()

function loadScript(provider: Provider): Promise<void> {
  const pending = scriptLoads.get(provider)
  if (pending) return pending
  const src = SCRIPT_SRC[provider]
  const load = new Promise<void>((resolve, reject) => {
    // A tag already on the page (put there by something else) has loaded or
    // is loading; the render below polls for the global either way.
    if (document.querySelector(`script[src="${src}"]`)) return resolve()
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => {
      // Let a later mount try again rather than inherit the failure.
      scriptLoads.delete(provider)
      s.remove()
      reject(new Error(`Failed to load ${provider} script`))
    }
    document.head.appendChild(s)
  })
  scriptLoads.set(provider, load)
  return load
}

interface CaptchaWidgetProps {
  /** Called with the token when solved, or empty string when reset/expired. */
  onToken: (token: string) => void
}

export function CaptchaWidget({ onToken }: CaptchaWidgetProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const resolved = resolveProvider()

  React.useEffect(() => {
    if (!resolved || !containerRef.current) return
    let cancelled = false
    let widgetId: string | undefined
    const { provider, siteKey } = resolved
    const globalName = provider === 'turnstile' ? 'turnstile' : 'hcaptcha'

    loadScript(provider)
      .then(() => {
        // Poll briefly until the API is ready: script onload can fire before
        // the global is attached (Turnstile's api.js loads a second script).
        const tryRender = (attempt = 0) => {
          if (cancelled || !containerRef.current) return
          const api = (window as any)[globalName]
          if (!api?.render) {
            if (attempt < 50) setTimeout(() => tryRender(attempt + 1), 100)
            return
          }
          widgetId = api.render(containerRef.current, {
            sitekey: siteKey,
            callback: (token: string) => onToken(token),
            'expired-callback': () => onToken(''),
            'error-callback': () => onToken(''),
          })
        }
        tryRender()
      })
      .catch(() => {
        // Script blocked/offline — leave token empty. Backend fails closed
        // when enforcement is on, so we don't silently pass.
      })

    return () => {
      cancelled = true
      if (widgetId !== undefined) {
        try {
          ;(window as any)[globalName]?.remove?.(widgetId)
        } catch {
          // The provider already tore the widget down.
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!resolved) return null

  return <div ref={containerRef} className="mt-1" data-testid="captcha-widget" />
}
