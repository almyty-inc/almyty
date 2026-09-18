import { describe, it, expect } from 'vitest'
import { forbiddenToastMessage } from '../api'

// The global exception filter answers every error as
// { error: { code, message, statusCode, ... } }. There is no top-level
// `message`, so the 403 interceptor's read of a flat data.message always
// fell through to the generic sentence and the backend's actual reason
// -- an access policy's decision.reason, a 402 entitlement refusal, a
// publish blocker -- never reached the toast.

describe('forbiddenToastMessage', () => {
  it('reads the wrapped shape the backend actually sends', () => {
    expect(
      forbiddenToastMessage({
        error: {
          code: 'ACCESS_DENIED',
          message: 'Team "Platform" does not own this gateway.',
          statusCode: 403,
        },
      }),
    ).toBe('Team "Platform" does not own this gateway.')
  })

  it('still reads a flat message from a handler that answers without the filter', () => {
    expect(forbiddenToastMessage({ message: 'Nope.' })).toBe('Nope.')
  })

  it('prefers the wrapped message when both are present', () => {
    expect(
      forbiddenToastMessage({ message: 'flat', error: { message: 'wrapped' } }),
    ).toBe('wrapped')
  })

  it('falls back to the generic sentence when there is no reason', () => {
    const generic = "You don't have permission to perform this action."
    expect(forbiddenToastMessage({ error: { code: 'X' } })).toBe(generic)
    expect(forbiddenToastMessage(undefined)).toBe(generic)
    expect(forbiddenToastMessage({ error: { message: '' } })).toBe(generic)
    expect(forbiddenToastMessage({ error: { message: 42 } })).toBe(generic)
  })
})
