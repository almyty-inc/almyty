import { describe, it, expect } from 'vitest'

import { providerKeyUrls } from '../provider-type-config'

// The provider types offered in the create-provider dialog's Select.
// `custom` is intentionally excluded — its key lives at the user's own
// endpoint, so there is no canonical "get your key" page.
const KEYED_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'xai',
  'deepseek',
  'groq',
  'together',
  'openrouter',
  'azure_openai',
  'aws_bedrock',
  'cohere',
  'huggingface',
]

describe('providerKeyUrls', () => {
  it('has a key-acquisition URL for every non-custom provider', () => {
    for (const p of KEYED_PROVIDERS) {
      expect(providerKeyUrls[p], `missing key URL for ${p}`).toBeTruthy()
    }
  })

  it('does not offer a link for custom (user-defined endpoint)', () => {
    expect(providerKeyUrls['custom']).toBeUndefined()
  })

  it('does not offer a link for ollama (keyless local server)', () => {
    expect(providerKeyUrls['ollama']).toBeUndefined()
  })

  it('every URL is a valid https URL', () => {
    for (const [provider, url] of Object.entries(providerKeyUrls)) {
      expect(url, `${provider} must be https`).toMatch(/^https:\/\/\S+$/)
      expect(() => new URL(url)).not.toThrow()
    }
  })

  it('deep-links known providers to their real key pages', () => {
    expect(providerKeyUrls['openai']).toBe('https://platform.openai.com/api-keys')
    expect(providerKeyUrls['anthropic']).toBe('https://console.anthropic.com/settings/keys')
  })
})
