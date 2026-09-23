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

  it('still refuses inline scripts', () => {
    expect(directive('script-src')).toEqual(["'self'"])
  })
})
