import { describe, it, expect } from 'vitest'

import { createProviderSchema } from '../schema'

/**
 * Keyless create is allowed for ollama only — every other provider type
 * keeps the required-key rule. Mirrors the backend
 * validateProviderConfiguration contract.
 */
describe('createProviderSchema', () => {
  it('allows a keyless ollama provider', () => {
    const result = createProviderSchema.safeParse({
      name: 'Local Ollama',
      type: 'ollama',
      apiKey: '',
    })
    expect(result.success).toBe(true)
  })

  it('allows an ollama provider with a base URL and no key', () => {
    const result = createProviderSchema.safeParse({
      name: 'Local Ollama',
      type: 'ollama',
      apiKey: '',
      apiUrl: 'http://localhost:11434',
    })
    expect(result.success).toBe(true)
  })

  it('still validates an ollama key when one is provided (auth proxy)', () => {
    const short = createProviderSchema.safeParse({
      name: 'Local Ollama',
      type: 'ollama',
      apiKey: 'abc',
    })
    expect(short.success).toBe(false)

    const ok = createProviderSchema.safeParse({
      name: 'Local Ollama',
      type: 'ollama',
      apiKey: 'proxy-token-123',
    })
    expect(ok.success).toBe(true)
  })

  it('still requires an API key for openai', () => {
    const missing = createProviderSchema.safeParse({
      name: 'OpenAI',
      type: 'openai',
      apiKey: '',
    })
    expect(missing.success).toBe(false)
    if (!missing.success) {
      expect(missing.error.issues[0].path).toEqual(['apiKey'])
    }
  })

  it('still rejects too-short keys for key-requiring providers', () => {
    const short = createProviderSchema.safeParse({
      name: 'OpenAI',
      type: 'openai',
      apiKey: 'sk-x',
    })
    expect(short.success).toBe(false)
  })

  it('accepts a normal keyed provider', () => {
    const result = createProviderSchema.safeParse({
      name: 'OpenAI Production',
      type: 'openai',
      apiKey: 'sk-test-1234567890',
    })
    expect(result.success).toBe(true)
  })
})
