import { describe, it, expect } from 'vitest'

import { LlmProviderType } from '@/types'
import { providerLogos, providerTypeLabels } from '../provider-type-config'
import { PROVIDER_TILE_GROUPS, PROVIDER_TILE_ORDER, defaultProviderName, providerTileLabel } from '../provider-catalog'

/**
 * The frontend's counterpart to the backend's dispatch-completeness spec.
 *
 * Hand-maintained provider lists drift the moment a type is added: a
 * provider the backend can call but /models/connect has no tile for cannot
 * be connected at all. Deriving from the enum only helps if something fails
 * when an entry is missing, which is this.
 */
describe('every provider type can be connected, and is named', () => {
  const all = Object.values(LlmProviderType)

  it('has a label for every type', () => {
    const missing = all.filter((t) => !providerTypeLabels[t])
    expect(missing).toEqual([])
  })

  it('has exactly one tile on /models/connect for every type', () => {
    const missing = all.filter((t) => !PROVIDER_TILE_ORDER.includes(t))
    expect(missing).toEqual([])
    // No type twice, and nothing that is not a type.
    expect(new Set(PROVIDER_TILE_ORDER).size).toBe(PROVIDER_TILE_ORDER.length)
    expect(PROVIDER_TILE_ORDER.filter((t) => !all.includes(t))).toEqual([])
  })

  it('puts the model makers first and your own server and Ollama last', () => {
    expect(PROVIDER_TILE_GROUPS.map((g) => g.id)).toEqual(['vendors', 'fleet', 'clouds', 'own'])
    expect(PROVIDER_TILE_ORDER.slice(0, 7)).toEqual(['openai', 'anthropic', 'google', 'mistral', 'xai', 'deepseek', 'cohere'])
    expect(PROVIDER_TILE_GROUPS.at(-1)?.types).toEqual(['custom', 'ollama'])
  })

  it('names nothing that is not a type, so a removed provider cannot linger in a form', () => {
    const strays = Object.keys(providerTypeLabels).filter((k) => !all.includes(k as LlmProviderType))
    expect(strays).toEqual([])
  })

  it('has a logo for every type, so no provider falls back to the generic icon', () => {
    const missing = all.filter((t) => !providerLogos[t])
    expect(missing).toEqual([])
  })

  it('gives each tile a distinct, non-empty label, and your own server a plain one', () => {
    const labels = PROVIDER_TILE_ORDER.map(providerTileLabel)
    expect(labels.every((l) => l.trim().length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
    expect(providerTileLabel('custom')).toBe('Your own server (OpenAI-compatible)')
    expect(defaultProviderName('openai')).toBe('OpenAI')
  })
})
