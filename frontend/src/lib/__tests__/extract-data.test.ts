import { describe, it, expect } from 'vitest'

import { extractData } from '../api'

// Regression for the wave of "double-unwrap" bugs in PR #108
// (memories), #119 (approvals), and #129 (organizations): every
// callsite that used apiGet/apiPost (which already pipe through
// extractData) was *also* doing query.data?.data, which always
// resolved to undefined and silently fell through to an empty
// state or stale fallback.
//
// These tests pin down extractData's contract so anyone who breaks
// it (or who re-introduces the double-unwrap pattern at a callsite)
// gets a loud failure.

describe('extractData', () => {
  it('unwraps {success, data} envelopes to the inner data', () => {
    const inner = [{ id: 'a' }, { id: 'b' }]
    expect(extractData({ data: { success: true, data: inner } } as any)).toBe(inner)
  })

  it('returns the body verbatim when there is no envelope', () => {
    const arr = [1, 2, 3]
    expect(extractData({ data: arr } as any)).toBe(arr)
  })

  it('returns the body verbatim when body is an object without a data key', () => {
    const obj = { foo: 'bar' }
    expect(extractData({ data: obj } as any)).toBe(obj)
  })

  it('returns null when the body is null', () => {
    expect(extractData({ data: null } as any)).toBeNull()
  })

  it('returns the body verbatim when body is a primitive', () => {
    expect(extractData({ data: 'hello' } as any)).toBe('hello')
    expect(extractData({ data: 42 } as any)).toBe(42)
  })
})
