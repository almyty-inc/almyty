import { describe, it, expect } from 'vitest'

import { slugFromHost, currentTenantSlug } from '../tenant-host'

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
