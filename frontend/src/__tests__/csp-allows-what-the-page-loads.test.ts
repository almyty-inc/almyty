import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Production refused the Google Fonts stylesheet and every Sentry report,
 * because index.html and the Sentry setup reach hosts the CSP never listed.
 * Nothing failed loudly: fonts fell back to system ones, error reports
 * vanished. These tie the CSP to what the app actually loads.
 */
const root = join(__dirname, '..', '..')
const html = readFileSync(join(root, 'index.html'), 'utf8')
const headers = readFileSync(join(root, 'nginx-security-headers.inc'), 'utf8')
const csp = headers.match(/Content-Security-Policy "([^"]+)"/)![1]
const directive = (name: string) =>
  (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '').split(/\s+/).slice(1)

describe('the CSP allows what the page loads', () => {
  it('allows every external stylesheet index.html links', () => {
    const hosts = [...html.matchAll(/<link\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /rel="stylesheet"/.test(tag))
      .map((tag) => tag.match(/href="(https:\/\/[^/"]+)/)?.[1])
      .filter((host): host is string => !!host)
    expect(hosts.length).toBeGreaterThan(0)
    for (const host of hosts) expect(directive('style-src')).toContain(host)
  })

  it('allows the font files Google Fonts serves', () => {
    if (html.includes('fonts.googleapis.com')) {
      expect(directive('font-src')).toContain('https://fonts.gstatic.com')
    }
  })

  it('lets Sentry deliver error reports', () => {
    const connect = directive('connect-src')
    expect(connect.some((src) => /sentry\.io$/.test(src))).toBe(true)
  })

  it('still refuses inline and eval scripts', () => {
    const script = directive('script-src')
    expect(script[0]).toBe("'self'")
    for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'", '*', 'https:']) {
      expect(script).not.toContain(unsafe)
    }
  })
})

/**
 * Sign-up broke on staging and production: the backend demanded a Turnstile
 * token, the bundle had the site key, but the CSP refused the Turnstile script
 * and its iframe, so no widget appeared and every sign-up was rejected.
 */
const widget = readFileSync(join(root, 'src', 'components', 'auth', 'captcha-widget.tsx'), 'utf8')
const widgetScripts = [...widget.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => new URL(m[1]))

// A CSP host source matches a hostname exactly, or `*.` matches any subdomain.
const allows = (sources: string[], url: URL) =>
  sources.some((src) => {
    if (!src.startsWith('https://')) return false
    const host = src.slice('https://'.length)
    return host.startsWith('*.') ? url.hostname.endsWith(host.slice(1)) : url.hostname === host
  })

describe('the CSP allows the sign-up captcha', () => {
  it('finds both provider script URLs in the widget', () => {
    expect(widgetScripts.map((u) => u.hostname).sort()).toEqual(['challenges.cloudflare.com', 'js.hcaptcha.com'])
  })

  it('allows every captcha script the widget loads', () => {
    for (const url of widgetScripts) expect(allows(directive('script-src'), url), url.href).toBe(true)
  })

  it('allows every captcha iframe', () => {
    for (const url of widgetScripts) expect(allows(directive('frame-src'), url), url.href).toBe(true)
  })

  it('lists Turnstile in script-src and frame-src, as Cloudflare documents', () => {
    expect(directive('script-src')).toContain('https://challenges.cloudflare.com')
    expect(directive('frame-src')).toContain('https://challenges.cloudflare.com')
  })

  it('lists hCaptcha in script, frame, style and connect-src, as hCaptcha documents', () => {
    for (const d of ['script-src', 'frame-src', 'style-src', 'connect-src']) {
      expect(directive(d)).toEqual(expect.arrayContaining(['https://hcaptcha.com', 'https://*.hcaptcha.com']))
    }
  })

  it('keeps same-origin frames, the default-src fallback frame-src had before', () => {
    expect(directive('frame-src')).toContain("'self'")
  })
})
