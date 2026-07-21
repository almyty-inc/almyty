import React from 'react'

/**
 * Optional CAPTCHA widget for the signup form.
 *
 * Renders ONLY when a public site key is configured via build-time env:
 *   VITE_TURNSTILE_SITE_KEY  -> Cloudflare Turnstile
 *   VITE_HCAPTCHA_SITE_KEY   -> hCaptcha
 *
 * When neither is set the component renders nothing and reports no token, so
 * the whole feature ships dark and matches the backend (which no-ops when
 * TURNSTILE_SECRET / HCAPTCHA_SECRET are unset). The provider script is loaded
 * lazily and only when a key exists.
 */

const TURNSTILE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined
const HCAPTCHA_KEY = import.meta.env.VITE_HCAPTCHA_SITE_KEY as string | undefined

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

function loadScript(provider: Provider): Promise<void> {
  const src = SCRIPT_SRC[provider]
  const existing = document.querySelector(`script[src="${src}"]`)
  if (existing) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`Failed to load ${provider} script`))
    document.head.appendChild(s)
  })
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
    const { provider, siteKey } = resolved

    loadScript(provider)
      .then(() => {
        if (cancelled || !containerRef.current) return
        // Both providers expose a global with a compatible render() signature.
        const api = (window as any)[provider === 'turnstile' ? 'turnstile' : 'hcaptcha']
        if (!api) return
        // Poll briefly until the API is ready (script onload can fire slightly
        // before the global is attached on some builds).
        const tryRender = (attempt = 0) => {
          const ready = (window as any)[provider === 'turnstile' ? 'turnstile' : 'hcaptcha']
          if (!ready?.render) {
            if (attempt < 20) setTimeout(() => tryRender(attempt + 1), 100)
            return
          }
          ready.render(containerRef.current, {
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!resolved) return null

  return <div ref={containerRef} className="mt-1" data-testid="captcha-widget" />
}
