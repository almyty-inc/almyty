import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Eleven components defined their own query under the key ['llm-providers'],
 * some caching an array and some the raw `{ providers }` envelope. Whichever
 * ran first owned the cache, and /models went blank when you arrived from a
 * page that had cached the envelope. The key may only be read through
 * `llmProvidersQuery`; invalidating it by key stays fine.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full)
    return /\.tsx?$/.test(name) ? [full] : []
  })
}

describe('one definition of the llm-providers query', () => {
  it('no component defines its own query under that key', () => {
    const root = join(__dirname, '..', '..')
    const offenders = sources(root).filter((file) => {
      if (file.endsWith('llm-providers-query.ts')) return false
      const src = readFileSync(file, 'utf8')
      return /useQuery\(\{[^}]*queryKey:\s*\['llm-providers'\]/s.test(src)
    })
    expect(offenders).toEqual([])
  })
})
