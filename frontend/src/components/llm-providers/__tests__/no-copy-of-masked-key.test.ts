import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The providers row menu used to offer "Copy API Key", reading
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
 * A source guard rather than a render test: the actions live in a closure
 * inside createActionsColumn and cannot be read back off the ColumnDef, and
 * driving a Radix dropdown open would test the menu library rather than
 * this. What matters is that no copy action is ever wired to a field the
 * server masks.
 */
describe('llm providers row menu', () => {
  const source = readFileSync(resolve(__dirname, '../columns.tsx'), 'utf8')

  it('never offers to copy the masked provider API key', () => {
    expect(source).not.toContain('configuration.apiKey')
    expect(source).not.toMatch(/Copy API Key/)
  })

  it('takes no clipboard helper at all, so one cannot be wired back in quietly', () => {
    expect(source).not.toContain('copySensitive')
    expect(source).not.toContain('useCopy')
  })
})
