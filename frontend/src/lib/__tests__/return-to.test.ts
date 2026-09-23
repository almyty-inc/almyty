import { describe, it, expect } from 'vitest'

import { safeReturnTo } from '../return-to'

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
