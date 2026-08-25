import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

// The shell is CommonJS because Electron's main process is, so it is
// loaded the way Electron loads it rather than through an import.
const { originOf, mayNavigateTo } = createRequire(import.meta.url)('./main.js')

/**
 * The window shows remote content under the customer's name, so the
 * only thing standing between it and an arbitrary page is this check.
 */
describe('originOf', () => {
  it('reads the origin of an app address', () => {
    expect(originOf('https://acme.almyty.app/chat')).toBe('https://acme.almyty.app')
  })

  it('does not treat a suffix match as the same origin', () => {
    // A startsWith check would pass this, and the window would happily
    // load an attacker's page wearing the customer's title bar.
    expect(originOf('https://acme.almyty.app.attacker.test/')).not.toBe(
      originOf('https://acme.almyty.app'),
    )
  })

  it('separates http from https on the same host', () => {
    expect(originOf('http://acme.almyty.app')).not.toBe(originOf('https://acme.almyty.app'))
  })

  it('separates a different port on the same host', () => {
    expect(originOf('https://acme.almyty.app:8443')).not.toBe(
      originOf('https://acme.almyty.app'),
    )
  })

  it('returns nothing for something that is not a URL', () => {
    expect(originOf('')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })

  it('refuses a scheme with no host rather than calling it an origin', () => {
    // These parse, and their origin is the STRING "null", so returning
    // it would make every one of them share a single origin: a data:
    // app address would then let a javascript: URL through.
    expect(originOf('javascript:alert(1)')).toBeNull()
    expect(originOf('data:text/html,hi')).toBeNull()
    expect(originOf('file:///etc/passwd')).toBeNull()
  })

  it('does not let two hostless URLs match each other', () => {
    expect(originOf('data:text/html,hi')).toBe(originOf('javascript:alert(1)'))
    // ...but both are null, and the shell only navigates when the
    // origin matches a non-null allowed origin.
    expect(originOf('data:text/html,hi')).toBeNull()
  })
})

describe('mayNavigateTo', () => {
  const APP = 'https://acme.almyty.app'

  it('follows a link within the app', () => {
    expect(mayNavigateTo(APP, 'https://acme.almyty.app/settings')).toBe(true)
  })

  it('refuses a lookalike host', () => {
    expect(mayNavigateTo(APP, 'https://acme.almyty.app.attacker.test/')).toBe(false)
  })

  it('refuses a downgrade to http', () => {
    expect(mayNavigateTo(APP, 'http://acme.almyty.app/')).toBe(false)
  })

  it('refuses everything when the build has no address', () => {
    // Otherwise null === null and a javascript: URL is "the same
    // origin" as the placeholder page.
    expect(mayNavigateTo(null, 'javascript:alert(1)')).toBe(false)
    expect(mayNavigateTo(null, 'https://acme.almyty.app/')).toBe(false)
  })

  it('refuses a hostless scheme from inside the app', () => {
    expect(mayNavigateTo(APP, 'javascript:alert(1)')).toBe(false)
    expect(mayNavigateTo(APP, 'file:///etc/passwd')).toBe(false)
  })
})
