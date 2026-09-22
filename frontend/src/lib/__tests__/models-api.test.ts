import { describe, it, expect, vi, beforeEach } from 'vitest'

import { api } from '../api'
import { modelsApi, formatModelPrice } from '../models-api'

function envelope(data: unknown = { ok: true }) {
  return Promise.resolve({ data: { success: true, data } })
}

let getSpy: ReturnType<typeof vi.spyOn>
let postSpy: ReturnType<typeof vi.spyOn>
let patchSpy: ReturnType<typeof vi.spyOn>
let deleteSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  getSpy = vi.spyOn(api, 'get').mockImplementation(() => envelope() as any)
  postSpy = vi.spyOn(api, 'post').mockImplementation(() => envelope() as any)
  patchSpy = vi.spyOn(api, 'patch').mockImplementation(() => envelope() as any)
  deleteSpy = vi.spyOn(api, 'delete').mockImplementation(() => envelope() as any)
})

describe('modelsApi', () => {
  it('lists cards without params when no filter is given', async () => {
    await modelsApi.list()
    expect(getSpy).toHaveBeenCalledWith('/models', undefined)
  })

  it('passes filters as query params', async () => {
    await modelsApi.list({ selectable: true, privacyTier: 'local' })
    expect(getSpy).toHaveBeenCalledWith('/models', { params: { selectable: true, privacyTier: 'local' } })
  })

  it('unwraps the envelope', async () => {
    getSpy.mockImplementation(() => envelope([{ id: 'c1', name: 'x' }]) as any)
    await expect(modelsApi.list()).resolves.toEqual([{ id: 'c1', name: 'x' }])
  })

  it('registers a card against a provider', async () => {
    await modelsApi.register({ name: 'Sonnet', vendorModelId: 'claude-sonnet-5', providerId: 'p1' })
    expect(postSpy).toHaveBeenCalledWith('/models', { name: 'Sonnet', vendorModelId: 'claude-sonnet-5', providerId: 'p1' }, undefined)
  })

  it('registers an endpoint', async () => {
    await modelsApi.registerEndpoint({ name: 'Local', url: 'http://10.0.0.5:8000/v1', vendorModelId: 'qwen3', privacyTier: 'local' })
    expect(postSpy).toHaveBeenCalledWith(
      '/models/register-endpoint',
      { name: 'Local', url: 'http://10.0.0.5:8000/v1', vendorModelId: 'qwen3', privacyTier: 'local' },
      undefined,
    )
  })

  it('syncs one provider with a body and all providers without one', async () => {
    await modelsApi.sync('p1')
    expect(postSpy).toHaveBeenCalledWith('/models/sync', { providerId: 'p1' }, undefined)
    await modelsApi.sync()
    expect(postSpy).toHaveBeenLastCalledWith('/models/sync', undefined, undefined)
  })

  it('gets, updates, validates and removes by id', async () => {
    await modelsApi.get('c1')
    expect(getSpy).toHaveBeenCalledWith('/models/c1', undefined)

    await modelsApi.update('c1', { privacyTier: 'private_cloud', pricingOverride: null })
    expect(patchSpy).toHaveBeenCalledWith('/models/c1', { privacyTier: 'private_cloud', pricingOverride: null }, undefined)

    await modelsApi.validate('c1')
    expect(postSpy).toHaveBeenCalledWith('/models/c1/validate', undefined, undefined)

    await modelsApi.remove('c1')
    expect(deleteSpy).toHaveBeenCalledWith('/models/c1', undefined)
  })

  it('returns the validation verdict even when the envelope says success: false', async () => {
    postSpy.mockImplementation(() => Promise.resolve({ data: { success: false, data: { passed: false, latencyMs: 12, error: 'model retired', model: { id: 'c1' } } } }) as any)
    const result = await modelsApi.validate('c1')
    expect(result.passed).toBe(false)
    expect(result.error).toBe('model retired')
  })
})

describe('formatModelPrice', () => {
  it('prints in/out per million tokens', () => {
    expect(formatModelPrice({ inPerMTok: 3, outPerMTok: 15, currency: 'USD' })).toBe('$3.00 in / $15.00 out')
    expect(formatModelPrice({ inPerMTok: 0.15, outPerMTok: 0.6 })).toBe('$0.15 in / $0.6 out')
  })

  it('says unpriced when nothing is known', () => {
    expect(formatModelPrice(null)).toBe('Unpriced')
  })
})
