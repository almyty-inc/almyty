import { describe, it, expect } from 'vitest'

import { loginReturnTo, safeReturnTo } from '../return-to'

const ORIGIN = 'https://app.almyty.com'

describe('safeReturnTo', () => {
  it('keeps a path on this origin, with its query and hash', () => {
    expect(safeReturnTo('/agents/a1/edit', ORIGIN)).toBe('/agents/a1/edit')
    expect(safeReturnTo('/agents/new?step=2#model', ORIGIN)).toBe('/agents/new?step=2#model')
  })

  it('never becomes an open redirect', () => {
    for (const bad of [
      'https://evil.example/phish',
      '//evil.example/phish',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'evil.example',
      ' //evil.example',
      '',
      null,
      undefined,
    ]) {
      expect(safeReturnTo(bad as string | null | undefined, ORIGIN)).toBeNull()
    }
  })
})

describe('loginReturnTo', () => {
  const API = 'https://api.almyty.com'
  const authorize = `${API}/acme/tools/authorize?response_type=code&client_id=c1&state=s`

  it('keeps a path on this origin, like the CLI login', () => {
    expect(loginReturnTo('/cli-login?code=abc', API, ORIGIN)).toBe('/cli-login?code=abc')
  })

  it('keeps the MCP OAuth authorize endpoint on the API, which bounces through login', () => {
    expect(loginReturnTo(authorize, API, ORIGIN)).toBe(authorize)
    expect(loginReturnTo('https://app.almyty.com/api/acme/tools/authorize?x=1', 'https://app.almyty.com/api', ORIGIN)).toBe(
      'https://app.almyty.com/api/acme/tools/authorize?x=1',
    )
  })

  it('refuses every other API URL, since some of them redirect onward', () => {
    for (const bad of [
      // An organization's SSO login redirects to the IdP that organization configured.
      `${API}/sso/attacker-org/oidc/login`,
      `${API}/sso/attacker-org/saml/login`,
      `${API}/r/some-code`,
      `${API}/acme/tools/authorize/../../sso/x/oidc/login`,
      `https://user:pass@api.almyty.com/acme/tools/authorize`,
      'https://api.almyty.com.evil.example/acme/tools/authorize',
      'https://evil.example/acme/tools/authorize',
      '//evil.example/x',
      '/\\evil.example',
    ]) {
      expect(loginReturnTo(bad, API, ORIGIN)).toBeNull()
    }
  })

  it('refuses API URLs altogether when no API base is configured', () => {
    expect(loginReturnTo(authorize, '', ORIGIN)).toBeNull()
  })
})