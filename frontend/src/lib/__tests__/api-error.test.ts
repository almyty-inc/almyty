import { describe, it, expect } from 'vitest'
import { getApiErrorMessage } from '../api-error'

describe('getApiErrorMessage', () => {
  it('reads response.data.error.message (wrapped shape)', () => {
    const err = { response: { data: { error: { message: 'name too long' } } } }
    expect(getApiErrorMessage(err)).toBe('name too long')
  })

  it('falls back to response.data.message (legacy shape)', () => {
    const err = { response: { data: { message: 'legacy msg' } } }
    expect(getApiErrorMessage(err)).toBe('legacy msg')
  })

  it('falls back to error.message for network errors', () => {
    const err = new Error('Network Error')
    expect(getApiErrorMessage(err)).toBe('Network Error')
  })

  it('uses the fallback when nothing is available', () => {
    expect(getApiErrorMessage(undefined, 'Operation failed')).toBe('Operation failed')
    expect(getApiErrorMessage({}, 'Operation failed')).toBe('Operation failed')
  })

  it('prefers wrapped over legacy when both exist', () => {
    const err = { response: { data: { message: 'legacy', error: { message: 'wrapped' } } } }
    expect(getApiErrorMessage(err)).toBe('wrapped')
  })
})
