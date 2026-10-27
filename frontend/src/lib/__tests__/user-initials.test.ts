import { describe, it, expect } from 'vitest'

import { userInitials } from '../utils'

/**
 * The sidebar avatar read "U" for everyone: the profile carried no `name`
 * (the backend now sends it), and the fallback was a fixed letter.
 */
describe('userInitials', () => {
  it('takes the initials of the name', () => {
    expect(userInitials({ name: 'Dana Lind', email: 'dana@acme.example' })).toBe('DL')
    expect(userInitials({ name: '  ana  maria  ', email: 'x@y.z' })).toBe('AM')
  })

  it('falls back to the email, never to a placeholder letter', () => {
    expect(userInitials({ name: '', email: 'dana.lind@acme.example' })).toBe('DL')
    expect(userInitials({ email: 'ops@acme.example' })).toBe('O')
    expect(userInitials(null)).toBe('?')
  })
})
