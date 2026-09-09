import { describe, it, expect } from 'vitest'

import { buildProviderCreateBody, buildProviderUpdateBody, createProviderSchema } from '../schema'

describe('buildProviderCreateBody', () => {
  it('sends a pasted key inside configuration and no credentialId', () => {
    expect(buildProviderCreateBody({ name: 'prod', type: 'openai', apiKey: 'sk-live-1234', usageApiKey: 'sk-admin-1' })).toEqual({
      name: 'prod',
      type: 'openai',
      configuration: { apiKey: 'sk-live-1234', usageApiKey: 'sk-admin-1' },
    })
  })

  it('sends a connected account as credentialId and drops any typed key', () => {
    expect(buildProviderCreateBody({ name: 'prod', type: 'openai', apiKey: 'sk-typed', connectionId: 'conn-1' })).toEqual({
      name: 'prod',
      type: 'openai',
      credentialId: 'conn-1',
      configuration: {},
    })
  })

  it('sends a picked vault credential as credentialId', () => {
    expect(buildProviderCreateBody({ name: 'prod', type: 'anthropic', credentialId: 'cred-9' }).credentialId).toBe('cred-9')
  })

  it('never sends the masked marker as a key', () => {
    const body = buildProviderCreateBody({ name: 'p', type: 'openai', apiKey: '***masked***', usageApiKey: '***masked***' })
    expect(body.configuration).toEqual({})
  })
})

describe('buildProviderUpdateBody', () => {
  const base = { name: 'prod', model: 'gpt-4o', maxTokens: 4096, temperature: 0.7 }

  it('leaves the credential fields out when the form did not touch them', () => {
    expect(buildProviderUpdateBody({ ...base, apiKey: '', usageApiKey: '' })).toEqual({
      name: 'prod',
      configuration: { model: 'gpt-4o', maxTokens: 4096, temperature: 0.7 },
    })
  })

  it('points the provider at a connection and sends no key next to it', () => {
    expect(buildProviderUpdateBody({ ...base, credentialId: 'conn-1', apiKey: 'sk-typed', usageCredentialId: 'conn-2', usageApiKey: 'adm-typed' })).toEqual({
      name: 'prod',
      credentialId: 'conn-1',
      usageCredentialId: 'conn-2',
      configuration: { model: 'gpt-4o', maxTokens: 4096, temperature: 0.7 },
    })
  })

  it('sends null to clear a connection', () => {
    const body = buildProviderUpdateBody({ ...base, usageCredentialId: null })
    expect(body).toHaveProperty('usageCredentialId', null)
    expect(body).not.toHaveProperty('credentialId')
  })

  it('carries a newly pasted key and never the masked marker', () => {
    expect(buildProviderUpdateBody({ ...base, apiKey: 'sk-new', usageApiKey: '***masked***' }).configuration).toEqual({
      model: 'gpt-4o', maxTokens: 4096, temperature: 0.7, apiKey: 'sk-new',
    })
  })
})

describe('createProviderSchema with an existing connection', () => {
  it('accepts a keyless form when credentialId names a connection', () => {
    expect(createProviderSchema.safeParse({ name: 'p', type: 'openai', credentialId: 'cred-1' }).success).toBe(true)
    expect(createProviderSchema.safeParse({ name: 'p', type: 'openai' }).success).toBe(false)
  })
})

describe('base URL (configuration.apiUrl)', () => {
  it('create sends the custom server URL as configuration.apiUrl', () => {
    expect(buildProviderCreateBody({ name: 'vLLM', type: 'custom', apiKey: 'sk-12345678', apiUrl: 'https://llm.example.internal/v1' })).toEqual({
      name: 'vLLM',
      type: 'custom',
      configuration: { apiKey: 'sk-12345678', apiUrl: 'https://llm.example.internal/v1' },
    })
  })

  it('update sends a typed base URL as configuration.apiUrl and leaves it out when blank', () => {
    expect(buildProviderUpdateBody({ name: 'vLLM', model: 'qwen', apiUrl: ' https://llm.example.internal/v1 ' }).configuration).toEqual({
      model: 'qwen',
      maxTokens: undefined,
      temperature: undefined,
      apiUrl: 'https://llm.example.internal/v1',
    })
    expect(buildProviderUpdateBody({ name: 'vLLM', apiUrl: '' }).configuration).not.toHaveProperty('apiUrl')
  })
})
