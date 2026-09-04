import { describe, expect, it } from 'vitest'
import { currentProviderFailure } from '../provider-health'

describe('currentProviderFailure', () => {
  it('reports a failure that is newer than the last success', () => {
    expect(
      currentProviderFailure({ lastError: 'HTTP 429', lastErrorAt: '2026-09-04T10:40:41Z', lastSuccessAt: '2026-09-04T09:00:00Z' }),
    ).toEqual({ message: 'HTTP 429', at: '2026-09-04T10:40:41Z' })
  })

  it('reports a failure when the provider has never succeeded', () => {
    expect(currentProviderFailure({ lastError: 'invalid api key', lastErrorAt: '2026-09-04T10:40:41Z' })).not.toBeNull()
  })

  it('treats an error older than the last success as history', () => {
    expect(
      currentProviderFailure({ lastError: 'HTTP 429', lastErrorAt: '2026-09-04T09:00:00Z', lastSuccessAt: '2026-09-04T10:40:41Z' }),
    ).toBeNull()
  })

  it('ignores a lastError without a timestamp (rows from before the column existed)', () => {
    expect(currentProviderFailure({ lastError: 'old', isHealthy: true })).toBeNull()
  })
})
