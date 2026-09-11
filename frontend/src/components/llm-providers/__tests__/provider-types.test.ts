import { describe, it, expect } from 'vitest'

import { LlmProviderType } from '@/types'
import { providerLogos, providerTypeLabels, providerTypeOptions } from '../provider-type-config'

/**
 * The frontend's counterpart to the backend's dispatch-completeness spec.
 *
 * Hand-maintained provider lists drift the moment a type is added: the
 * filter on the providers page sat eight entries behind the create form,
 * so several providers could be created and then never filtered for, and
 * the newest seven had no logo. Deriving both lists from the enum only
 * helps if something fails when an entry is missing, which is this.
 */
describe('every provider type is offered and named', () => {
  const all = Object.values(LlmProviderType)

  it('has a label for every type, and offers every one of them', () => {
    const missing = all.filter((t) => !providerTypeLabels[t])
    expect(missing).toEqual([])
    expect(providerTypeOptions.map((o) => o.value).sort()).toEqual([...all].sort())
  })

  it('names nothing that is not a type, so a removed provider cannot linger in a form', () => {
    const strays = Object.keys(providerTypeLabels).filter((k) => !all.includes(k as LlmProviderType))
    expect(strays).toEqual([])
  })

  it('has a logo for every type, so no provider falls back to the generic icon', () => {
    const missing = all.filter((t) => !providerLogos[t])
    expect(missing).toEqual([])
  })

  it('gives each type a distinct, non-empty label', () => {
    const labels = providerTypeOptions.map((o) => o.label)
    expect(labels.every((l) => l.trim().length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
