import { describe, it, expect } from 'vitest'
import { createGatewaySchema } from '../schema'

describe('createGatewaySchema', () => {
  const valid = { name: 'My Gateway', type: 'mcp', endpoint: '/my-gw' }

  it('requires name', () => {
    expect(createGatewaySchema.safeParse({ ...valid, name: '' }).success).toBe(false)
  })

  it('rejects names longer than 100 characters', () => {
    const r = createGatewaySchema.safeParse({ ...valid, name: 'a'.repeat(101) })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message === 'Name must be 100 characters or fewer')).toBe(true)
    }
  })

  it('accepts a name at the 100-character boundary', () => {
    expect(createGatewaySchema.safeParse({ ...valid, name: 'a'.repeat(100) }).success).toBe(true)
  })

  it('rejects endpoint paths longer than 200 characters', () => {
    const long = '/' + 'a'.repeat(200)
    const r = createGatewaySchema.safeParse({ ...valid, endpoint: long })
    expect(r.success).toBe(false)
  })

  it('rejects endpoint paths without leading slash', () => {
    expect(createGatewaySchema.safeParse({ ...valid, endpoint: 'no-slash' }).success).toBe(false)
  })

  it('rejects endpoint paths with disallowed characters', () => {
    expect(createGatewaySchema.safeParse({ ...valid, endpoint: '/spaces here' }).success).toBe(false)
  })

  it('rejects descriptions longer than 1000 characters', () => {
    expect(createGatewaySchema.safeParse({ ...valid, description: 'd'.repeat(1001) }).success).toBe(false)
  })

  it('requires type', () => {
    expect(createGatewaySchema.safeParse({ ...valid, type: '' }).success).toBe(false)
  })
})
