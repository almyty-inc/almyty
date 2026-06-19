import { describe, it, expect } from 'vitest'
import { createApiSchema } from '../schema'
import { ApiType, ApiAuthType } from '@/types'

describe('createApiSchema', () => {
  const valid = {
    name: 'My API',
    type: ApiType.OPENAPI,
    baseUrl: 'https://api.example.com/v1',
    authentication: { type: ApiAuthType.NONE, config: {} },
  }

  it('requires name at least 2 chars', () => {
    const result = createApiSchema.safeParse({ ...valid, name: 'a' })
    expect(result.success).toBe(false)
  })

  it('rejects names longer than 100 characters', () => {
    const result = createApiSchema.safeParse({ ...valid, name: 'a'.repeat(101) })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.message === 'Name must be 100 characters or fewer')).toBe(true)
    }
  })

  it('accepts a name at the 100-character boundary', () => {
    const result = createApiSchema.safeParse({ ...valid, name: 'a'.repeat(100) })
    expect(result.success).toBe(true)
  })

  it('rejects descriptions longer than 1000 characters', () => {
    const result = createApiSchema.safeParse({ ...valid, description: 'd'.repeat(1001) })
    expect(result.success).toBe(false)
  })

  it('rejects invalid URLs for non-SDK types', () => {
    const result = createApiSchema.safeParse({ ...valid, baseUrl: 'not-a-url' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.message === 'Please enter a valid URL')).toBe(true)
    }
  })

  it('accepts SDK type without a URL', () => {
    const result = createApiSchema.safeParse({ ...valid, type: ApiType.SDK, baseUrl: '' })
    expect(result.success).toBe(true)
  })
})
