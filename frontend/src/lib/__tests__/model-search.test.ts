import { describe, expect, it } from 'vitest'

import { modelSearchScorer, normalizeModelSearch, rankBy, textMatchesSearch, type ModelSearchFields } from '../model-search'
import { SEARCH_CASES, SEARCH_CATALOG } from './model-search.cases'

const searchModels = (items: ModelSearchFields[], query: string) => rankBy(items, modelSearchScorer(items, query, (m) => m))

describe('searchModels', () => {
  it.each(SEARCH_CASES)('"$query" lists $expected ($why)', ({ query, expected }) => {
    expect(searchModels(SEARCH_CATALOG, query).map((m) => m.id)).toEqual(expected)
  })

  it('decides the provider fallback over the whole list, not per provider', () => {
    // "anthropic" is also a model id here, so the Anthropic provider name does not count.
    const list = [...SEARCH_CATALOG, { id: 'anthropic-proxy', providerName: 'My server', providerType: 'custom' }]
    expect(searchModels(list, 'anthropic').map((m) => m.id)).toEqual(['anthropic-proxy'])
  })
})

describe('normalizeModelSearch', () => {
  it('drops case and every separator', () => {
    expect(normalizeModelSearch(' GPT-4o_mini.2024/08:06 ')).toBe('gpt4omini20240806')
    expect(normalizeModelSearch(null)).toBe('')
  })
})

describe('textMatchesSearch', () => {
  it('matches any text loosely, and everything on an empty query', () => {
    expect(textMatchesSearch('provider def', 'Provider default')).toBe(true)
    expect(textMatchesSearch('gpt4o', 'nope', 'GPT-4o')).toBe(true)
    expect(textMatchesSearch('zzz', 'Provider default')).toBe(false)
    expect(textMatchesSearch('', 'x')).toBe(true)
  })
})
