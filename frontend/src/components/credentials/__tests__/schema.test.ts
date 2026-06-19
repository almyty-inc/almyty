import { describe, it, expect } from 'vitest'
import { createCredentialSchema } from '../schema'

describe('createCredentialSchema', () => {
  const valid = { name: 'Stripe Key', type: 'api_key', value: 'sk_test_123' }

  it('requires a name', () => {
    expect(createCredentialSchema.safeParse({ ...valid, name: '' }).success).toBe(false)
  })

  it('rejects names longer than 200 characters', () => {
    const r = createCredentialSchema.safeParse({ ...valid, name: 'a'.repeat(201) })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message === 'Name must be 200 characters or fewer')).toBe(true)
    }
  })

  it('accepts a name at the 200-character boundary', () => {
    expect(createCredentialSchema.safeParse({ ...valid, name: 'a'.repeat(200) }).success).toBe(true)
  })

  it('requires a value', () => {
    expect(createCredentialSchema.safeParse({ ...valid, value: '' }).success).toBe(false)
  })

  it('rejects descriptions longer than 2000 characters', () => {
    expect(createCredentialSchema.safeParse({ ...valid, description: 'd'.repeat(2001) }).success).toBe(false)
  })

  it('rejects type strings longer than 50 characters', () => {
    expect(createCredentialSchema.safeParse({ ...valid, type: 'x'.repeat(51) }).success).toBe(false)
  })
})
