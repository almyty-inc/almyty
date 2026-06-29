import { describe, it, expect } from 'vitest'
import { createToolSchema } from '../schema'

describe('createToolSchema', () => {
  it('requires a name', () => {
    const result = createToolSchema.safeParse({ name: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Name is required')
    }
  })

  it('rejects names longer than 100 characters', () => {
    const result = createToolSchema.safeParse({ name: 'a'.repeat(101) })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Name must be 100 characters or fewer')
    }
  })

  it('accepts a name at the 100-character boundary', () => {
    const result = createToolSchema.safeParse({ name: 'a'.repeat(100) })
    expect(result.success).toBe(true)
  })

  it('rejects descriptions longer than 1000 characters', () => {
    const result = createToolSchema.safeParse({
      name: 'ok',
      description: 'd'.repeat(1001),
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Description must be 1000 characters or fewer')
    }
  })

  it('accepts a missing description', () => {
    const result = createToolSchema.safeParse({ name: 'ok' })
    expect(result.success).toBe(true)
  })

  it('accepts a 1000-character description at the boundary', () => {
    const result = createToolSchema.safeParse({
      name: 'ok',
      description: 'd'.repeat(1000),
    })
    expect(result.success).toBe(true)
  })
})
