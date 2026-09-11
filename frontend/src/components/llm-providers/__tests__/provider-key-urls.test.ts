import { describe, it, expect } from 'vitest'

import { providerKeyUrls } from '../provider-type-config'
import { LlmProviderType } from '@/types'

/**
 * Derived from the enum, not hand-written: a hardcoded list is how the
 * provider dialogs kept shipping types with no "get your key" link. Adding
 * an enum value now fails this until it is mapped.
 *
 * `custom` is intentionally excluded - its key lives at the user's own
 * endpoint, so there is no canonical key page.
 */
const KEYED_PROVIDERS = Object.values(LlmProviderType).filter((t) => t !== LlmProviderType.CUSTOM)

describe('providerKeyUrls', () => {
  it('has a key-acquisition URL for every non-custom provider', () => {
    for (const p of KEYED_PROVIDERS) {
      expect(providerKeyUrls[p], `missing key URL for ${p}`).toBeTruthy()
    }
  })

  it('does not offer a link for custom (user-defined endpoint)', () => {
    expect(providerKeyUrls['custom']).toBeUndefined()
  })

  it('ollama links the cloud key page (local mode is keyless)', () => {
    expect(providerKeyUrls['ollama']).toBe('https://ollama.com/settings/keys')
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

  it('links the OpenAI-compatible inference hosts to their key consoles', () => {
    expect(providerKeyUrls['fireworks']).toBe('https://app.fireworks.ai/settings/users/api-keys')
    expect(providerKeyUrls['cerebras']).toBe('https://cloud.cerebras.ai')
    expect(providerKeyUrls['deepinfra']).toBe('https://deepinfra.com/dash/api_keys')
    expect(providerKeyUrls['novita']).toBe('https://novita.ai/settings/key-management')
    expect(providerKeyUrls['perplexity']).toBe('https://console.perplexity.ai')
    expect(providerKeyUrls['zai']).toBe('https://z.ai/manage-apikey/apikey-list')
    expect(providerKeyUrls['baseten']).toBe('https://app.baseten.co/settings/api_keys')
    expect(providerKeyUrls['nebius']).toBe('https://tokenfactory.nebius.com/settings/api-keys')
    expect(providerKeyUrls['sambanova']).toBe('https://cloud.sambanova.ai/apis')
  })
})
