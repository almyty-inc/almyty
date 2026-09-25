import { describe, it, expect } from 'vitest'
import { editApiSchema } from '../schema'

describe('editApiSchema', () => {
  const valid = { name: 'My API', baseUrl: 'https://api.example.com/v1' }

  it('requires name at least 2 chars', () => {
    expect(editApiSchema.safeParse({ ...valid, name: 'a' }).success).toBe(false)
  })

  it('rejects names longer than 100 characters', () => {
    const result = editApiSchema.safeParse({ ...valid, name: 'a'.repeat(101) })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message === 'Name must be 100 characters or fewer')).toBe(true)
    }
  })

  it('accepts a name at the 100-character boundary', () => {
    expect(editApiSchema.safeParse({ ...valid, name: 'a'.repeat(100) }).success).toBe(true)
  })

  it('rejects descriptions longer than 1000 characters', () => {
    expect(editApiSchema.safeParse({ ...valid, description: 'd'.repeat(1001) }).success).toBe(false)
  })

  it('rejects an address that is not http(s)', () => {
    const result = editApiSchema.safeParse({ ...valid, baseUrl: 'not-a-url' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Enter an address starting with http:// or https://')
    }
  })

  it('accepts an empty address: an SDK API, or a .proto that named none yet', () => {
    expect(editApiSchema.safeParse({ ...valid, baseUrl: '' }).success).toBe(true)
  })
})
