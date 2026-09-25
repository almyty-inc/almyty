import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The old providers row menu offered "Copy API Key", reading
 * `provider.configuration.apiKey` straight off the list response.
 *
 * That value is NEVER the key. Every read path masks it:
 * LlmProvider.maskSensitiveData() answers the literal '***masked***', and
 * the list endpoint masks unconditionally (llm-providers.service.ts) — only
 * `GET /llm-providers/:id?includeSecrets=true` returns the real one, and
 * the list page never asks for it. So the action put '***masked***' on the
 * clipboard and raised the "API key copied — this value is sensitive"
 * toast. The user pastes it into a CI secret or a .env and the integration
 * fails days later with an opaque auth error, blamed on the wrong thing.
 *
 * A source guard over the pages that show providers now (the Models page's
 * provider cards and a provider's own page): no copy action is ever wired
 * to a field the server masks.
 */
describe('provider cards and pages', () => {
  const source = ['../../../pages/models.tsx', '../../../pages/provider.tsx']
    .map((p) => readFileSync(resolve(__dirname, p), 'utf8'))
    .join('\n')

  it('never offers to copy the masked provider API key', () => {
    expect(source).not.toMatch(/configuration\.apiKey(?!\))/)
    expect(source).not.toMatch(/Copy API Key/)
  })

  it('takes no clipboard helper at all, so one cannot be wired back in quietly', () => {
    expect(source).not.toContain('copySensitive')
    expect(source).not.toContain('useCopy')
  })
})
