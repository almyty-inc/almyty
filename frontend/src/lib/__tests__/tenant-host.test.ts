import { describe, it, expect, afterEach } from 'vitest'

import {
  slugFromHost,
  currentTenantSlug,
  isHostedChatHost,
  hostedChatBaseDomain,
} from '../tenant-host'

describe('slugFromHost', () => {
  const base = 'almyty.app'

  it('reads the tenant label off a subdomain', () => {
    expect(slugFromHost('acme.almyty.app', base)).toBe('acme')
    expect(slugFromHost('acme-support.almyty.app', base)).toBe('acme-support')
  })

  it('ignores the port and normalises case', () => {
    expect(slugFromHost('ACME.almyty.app:5173', base)).toBe('acme')
  })

  it('returns null for the apex so it can serve something else', () => {
    expect(slugFromHost('almyty.app', base)).toBeNull()
  })

  it('returns null for an unrelated host rather than inventing a tenant', () => {
    // Without the suffix check, acme.evil.com would load the surface
    // named "acme" and take its session cookie along for the ride.
    expect(slugFromHost('acme.evil.com', base)).toBeNull()
    expect(slugFromHost('almyty.app.evil.com', base)).toBeNull()
  })

  it('rejects a nested label, which is not a tenant', () => {
    expect(slugFromHost('a.b.almyty.app', base)).toBeNull()
  })

  it('refuses hosts we route ourselves', () => {
    for (const reserved of ['www', 'api', 'app', 'docs']) {
      expect(slugFromHost(`${reserved}.almyty.app`, base)).toBeNull()
    }
  })

  it('leaves the dashboard and localhost alone', () => {
    expect(slugFromHost('app.almyty.com', base)).toBeNull()
    expect(slugFromHost('localhost', base)).toBeNull()
  })

  it('follows a self-hosted base domain', () => {
    // The feature is Apache core; the domain is deployment config.
    expect(slugFromHost('support.chat.acme.com', 'chat.acme.com')).toBe('support')
    expect(slugFromHost('support.almyty.app', 'chat.acme.com')).toBeNull()
  })

  it('returns null for a missing host', () => {
    expect(slugFromHost(undefined, base)).toBeNull()
  })
})

describe('currentTenantSlug', () => {
  it('derives the tenant from the page hostname', () => {
    const location = { hostname: 'acme.almyty.app', search: '' } as Location
    expect(currentTenantSlug(location)).toBe('acme')
  })

  it('is null on the dashboard host, so routing is unchanged', () => {
    const location = { hostname: 'app.almyty.com', search: '' } as Location
    expect(currentTenantSlug(location)).toBeNull()
  })
})

describe('isHostedChatHost', () => {
  it('is true on a tenant subdomain', () => {
    const location = { hostname: 'acme.almyty.app', search: '' } as Location
    expect(isHostedChatHost(location)).toBe(true)
  })

  it('is false on the dashboard host', () => {
    const location = { hostname: 'app.almyty.com', search: '' } as Location
    expect(isHostedChatHost(location)).toBe(false)
  })
})


type RuntimeWindow = typeof window & {
  __ALMYTY_RUNTIME__?: { hostedChatBaseDomain?: string }
}

describe('hostedChatBaseDomain (runtime k8s config)', () => {
  afterEach(() => {
    delete (window as RuntimeWindow).__ALMYTY_RUNTIME__
  })

  it('reads the domain the container injected at runtime', () => {
    ;(window as RuntimeWindow).__ALMYTY_RUNTIME__ = {
      hostedChatBaseDomain: 'staging.almyty.app',
    }
    expect(hostedChatBaseDomain()).toBe('staging.almyty.app')
  })

  it('normalises case and whitespace on the runtime value', () => {
    ;(window as RuntimeWindow).__ALMYTY_RUNTIME__ = {
      hostedChatBaseDomain: '  Staging.Almyty.App ',
    }
    expect(hostedChatBaseDomain()).toBe('staging.almyty.app')
  })

  it('falls back to the default when the runtime value is empty', () => {
    ;(window as RuntimeWindow).__ALMYTY_RUNTIME__ = { hostedChatBaseDomain: '' }
    expect(hostedChatBaseDomain()).toBe('almyty.app')
  })

  it('falls back to the default when no runtime config is present', () => {
    expect(hostedChatBaseDomain()).toBe('almyty.app')
  })

  it('drives slugFromHost, so a config change moves the tenant boundary', () => {
    // This is the whole point of runtime config: change the k8s value and
    // the tenant host boundary follows, no image rebuild.
    ;(window as RuntimeWindow).__ALMYTY_RUNTIME__ = {
      hostedChatBaseDomain: 'staging.almyty.app',
    }
    expect(slugFromHost('acme.staging.almyty.app')).toBe('acme')
    expect(slugFromHost('acme.almyty.app')).toBeNull()
  })
})
