import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Vite's dev proxy matches a string key as a plain prefix, first key wins.
 *
 * The hosted-chat rule was keyed '/api', which is also a prefix of
 * '/apis': in dev the APIs page's list request went to the backend as
 * '/s' and a reload of /apis proxied the page itself. A later, longer key
 * never gets a chance once an earlier, shorter one has swallowed it.
 */
describe('vite dev proxy keys', () => {
  const config = readFileSync(join(__dirname, '..', '..', 'vite.config.ts'), 'utf8')
  const keys = [...config.matchAll(/^\s{6}'(\/[^']*)':/gm)].map((m) => m[1])

  it('are read from the config', () => {
    expect(keys.length).toBeGreaterThan(20)
    expect(keys).toContain('/apis')
  })

  it('never let an earlier key swallow a later route by bare prefix', () => {
    const collisions: string[] = []
    keys.forEach((earlier, i) => {
      keys.slice(i + 1).forEach((later) => {
        const next = later.charAt(earlier.length)
        if (later.startsWith(earlier) && /[A-Za-z0-9_-]/.test(next)) {
          collisions.push(`'${earlier}' catches '${later}'`)
        }
      })
    })
    expect(collisions).toEqual([])
  })

  it('anchors the hosted-chat /api rule so it cannot match /apis', () => {
    const apiKey = [...config.matchAll(/^\s{6}'(\^\/api[^']*)':/gm)].map((m) => m[1])[0]
    expect(apiKey).toBeDefined()
    const re = new RegExp(apiKey)
    expect(re.test('/api/chat')).toBe(true)
    expect(re.test('/apis')).toBe(false)
    expect(re.test('/apis/123')).toBe(false)
  })
})
