import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { cspFor } from '../../vite.csp-preview.config'

/**
 * The frontend image's CSP named https://*.almyty.com as the only API host,
 * so an image built for any other API (a self-hoster's domain, or the
 * Dockerfile's default http://localhost:3000) had every API call refused.
 * The API source now comes from ALMYTY_API_BASE_URL when the container
 * starts. cspFor runs the real entrypoint script against the real header.
 */
const root = join(__dirname, '..', '..')
const directive = (csp: string, name: string) =>
  (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '').split(/\s+/).slice(1)

describe('the CSP admits the API the image was built for', () => {
  it('keeps *.almyty.com for our own deploys, and frames only the API host', () => {
    for (const api of ['https://api.almyty.com', 'https://api.staging.almyty.com', 'https://api.dev.almyty.com']) {
      const csp = cspFor(api)
      expect(directive(csp, 'connect-src')).toContain('https://*.almyty.com')
      expect(directive(csp, 'frame-src')).toContain(api)
      expect(directive(csp, 'frame-src')).not.toContain('https://*.almyty.com')
    }
  })

  it('admits a self-hosted API on any other domain, and nothing of ours', () => {
    const csp = cspFor('https://api.example.org/api/')
    expect(directive(csp, 'connect-src')).toContain('https://api.example.org')
    expect(directive(csp, 'frame-src')).toContain('https://api.example.org')
    expect(csp).not.toContain('almyty.com')
  })

  it("admits the Dockerfile's default API URL, port included", () => {
    const csp = cspFor('http://localhost:3000')
    expect(directive(csp, 'connect-src')).toContain('http://localhost:3000')
    expect(directive(csp, 'frame-src')).toContain('http://localhost:3000')
  })

  it("adds nothing for a same-origin API ('self' covers it)", () => {
    for (const api of ['', '/api']) {
      const csp = cspFor(api)
      expect(directive(csp, 'connect-src')[0]).toBe("'self'")
      expect(directive(csp, 'connect-src')[1]).toBe('https://*.ingest.de.sentry.io')
      expect(directive(csp, 'frame-src')[1]).toBe('https://challenges.cloudflare.com')
    }
  })

  it('cannot be made to add a directive or a wildcard', () => {
    for (const api of ['https://x.example; script-src *', 'https://x.example" always; add_header X 1;', 'javascript:alert(1)', 'https://*']) {
      const csp = cspFor(api)
      expect(directive(csp, 'script-src')).not.toContain('*')
      expect(csp).not.toContain('x.example')
      expect(directive(csp, 'connect-src')[1]).toBe('https://*.ingest.de.sentry.io')
    }
  })

  it('has no API host written into the header itself', () => {
    const inc = readFileSync(join(root, 'nginx-security-headers.inc'), 'utf8')
    const header = inc.match(/Content-Security-Policy "([^"]+)"/)![1]
    expect(header).not.toContain('almyty.com')
    expect(directive(header, 'connect-src')).toContain('$almyty_api_connect_src')
    expect(directive(header, 'frame-src')).toContain('$almyty_api_frame_src')
  })

  it('wires the generated file into nginx and the build-time API URL into the image', () => {
    const conf = readFileSync(join(root, 'nginx.conf'), 'utf8')
    expect(conf).toMatch(/^include \/tmp\/almyty-csp\.conf;$/m)
    expect(conf.indexOf('include /tmp/almyty-csp.conf;')).toBeLessThan(conf.indexOf('server {'))
    // The entrypoint runs in the nginx stage, so the build arg must reach it.
    const production = readFileSync(join(root, 'Dockerfile'), 'utf8').split(/^FROM /m).find((s) => s.includes('AS production'))!
    expect(production).toMatch(/^ARG ALMYTY_API_BASE_URL=http:\/\/localhost:3000$/m)
    expect(production).toMatch(/^ENV ALMYTY_API_BASE_URL=\$ALMYTY_API_BASE_URL$/m)
  })
})
