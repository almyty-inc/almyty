import { describe, expect, it } from 'vitest'

import { providerCheck } from '../provider-status'
import { availability } from '@/components/models/model-row'

const checked = { status: 'active', isHealthy: true, lastHealthCheckAt: '2026-11-11T10:00:00Z', keyChecked: true }

describe('providerCheck', () => {
  it('says "Key works" when the key passed and its models can be used', () => {
    expect(providerCheck({ ...checked, modelCounts: { listed: 41, usable: 3 } })).toEqual({ state: 'ok', label: 'Key works' })
    // No counts sent: the key rule alone.
    expect(providerCheck(checked).label).toBe('Key works')
  })

  // "Key works" sat over a picker saying "41 models listed, none usable".
  it('does not say "Key works" over a list where nothing can be used', () => {
    const check = providerCheck({ ...checked, modelCounts: { listed: 41, usable: 0 } })
    expect(check.state).toBe('failed')
    expect(check.label).toBe('No usable models')
    expect(check.error).toContain('none of the 41 models')
  })

  it('a connection that lists nothing yet still reads by its key', () => {
    expect(providerCheck({ ...checked, modelCounts: { listed: 0, usable: 0 } }).label).toBe('Key works')
  })

  it('a model under such a connection is not blamed on the key', () => {
    const provider = { ...checked, name: 'Mistral', modelCounts: { listed: 41, usable: 0 } }
    const a = availability({ selectable: false, status: 'active', validationStatus: 'failed', lastValidationError: 'not in your plan', metadata: {} } as any, provider as any)
    expect(a.label).toBe('Not available')
    expect(a.detail).toBe('not in your plan')
  })
})
