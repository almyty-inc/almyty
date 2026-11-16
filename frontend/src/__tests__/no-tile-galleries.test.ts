/**
 * Pick-one screens are simple lists, not galleries of tiles: a kind of
 * channel is picked from OptionList (picking only selects, Add channel
 * adds), a kind of API from PickList (each row opens its own form).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('pick-one screens are lists', () => {
  it.each([
    ['pages/agent-channel-new.tsx', /<OptionList\b/],
    ['pages/api-new.tsx', /<PickList\b/],
  ])('%s uses the shared list, not tiles', (file, list) => {
    const source = read(file)
    expect(source).toMatch(list)
    expect(source).not.toMatch(/<ChoiceTiles?\b/)
  })
})
