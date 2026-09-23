import { describe, it, expect } from 'vitest'
import { toolSourceApi } from '../tool-source'

// Tools seeded without an operation or a metadata copy had a real apiId and
// a loaded `api` relation, and the list still printed "Unknown API".
describe('toolSourceApi', () => {
  it('names the API from the tool’s own relation when metadata has no copy', () => {
    expect(toolSourceApi({ apiId: 'a1', api: { id: 'a1', name: 'Billing' }, metadata: {} })).toEqual({
      id: 'a1',
      name: 'Billing',
    })
  })

  it('falls back to the operation’s API, then to the metadata copy', () => {
    expect(toolSourceApi({ operation: { api: { id: 'a2', name: 'CRM' } } }).name).toBe('CRM')
    expect(toolSourceApi({ apiId: 'a3', metadata: { sourceApi: { name: 'Legacy' } } })).toEqual({
      id: 'a3',
      name: 'Legacy',
    })
  })

  it('prefers the live relation over a stale metadata copy', () => {
    expect(
      toolSourceApi({ api: { id: 'a1', name: 'Billing v2' }, metadata: { sourceApi: { id: 'a1', name: 'Billing' } } }).name,
    ).toBe('Billing v2')
  })

  it('has no name when the API is gone', () => {
    expect(toolSourceApi({ apiId: 'gone', api: null }).name).toBeUndefined()
  })
})
