import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * The Petstore sample is gone from the product: no page offers to load a
 * canned workspace. The getting-started card guides people to connect
 * their OWN API instead. This guard keeps a "Load the Petstore sample"
 * button from growing back on some empty state.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full)
    return /\.(tsx?|jsx?)$/.test(name) ? [full] : []
  })
}

// Reads every source file synchronously: well under a second alone, but a
// busy CI runner can push it past vitest's 5s default.
describe('no canned sample workspace in the product', { timeout: 30_000 }, () => {
  const root = join(__dirname, '..', '..')
  const files = sources(root)

  it('mentions Petstore nowhere in shipped frontend code', () => {
    const offenders = files.filter((f) => /petstore/i.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('has no client for the removed sample-workspace endpoints', () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('sample-workspace'))
    expect(offenders).toEqual([])
  })
})
