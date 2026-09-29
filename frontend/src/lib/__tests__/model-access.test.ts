import { describe, expect, it } from 'vitest'

import { accessSummary, allowsModel, modelAccessBody, modelAccessOf, tickedModels, withSwitch, withTicked } from '../model-access'

const ALL = ['llama', 'qwen', 'deepseek']

describe('a connection\'s models', () => {
  it('allows everything on a connection nobody changed', () => {
    const access = modelAccessOf({})
    expect(access.allowNewModels).toBe(true)
    expect(tickedModels(access, ALL)).toEqual(ALL)
    expect(allowsModel(access, 'listed-later')).toBe(true)
  })

  it('switch on: unticking hides a model and new ones stay allowed', () => {
    const access = withTicked(modelAccessOf({}), ALL, ['llama', 'deepseek'])
    expect(access.hiddenModels).toEqual(['qwen'])
    expect(allowsModel(access, 'listed-later')).toBe(true)
    expect(accessSummary(access, ALL)).toBe('2 of 3 models')
  })

  it('switch off: only what is ticked, and a new model stays off; flipping keeps today\'s ticks', () => {
    const on = withTicked(modelAccessOf({}), ALL, ['llama'])
    const off = withSwitch(on, ALL, false)
    expect(off).toMatchObject({ allowNewModels: false, allowedModels: ['llama'], hiddenModels: ['qwen', 'deepseek'] })
    expect(allowsModel(off, 'listed-later')).toBe(false)
    expect(accessSummary(off, ALL, (id) => id.toUpperCase())).toBe('Only LLAMA')
    expect(tickedModels(withSwitch(off, ALL, true), ALL)).toEqual(['llama'])
  })

  it('keeps a hidden id the vendor stopped listing, in case it comes back', () => {
    const access = withTicked(modelAccessOf({ hiddenModels: ['retired'] }), ALL, ALL)
    expect(access.hiddenModels).toEqual(['retired'])
  })

  it('sends null for an empty list', () => {
    expect(modelAccessBody(modelAccessOf({}))).toEqual({ allowNewModels: true, hiddenModels: null, allowedModels: null })
    expect(accessSummary(modelAccessOf({}), ALL)).toBe('All 3 models, and new ones')
  })
})
