import { describe, it, expect } from 'vitest'

import { buildProviderCreateBody } from '../llm-providers/schema'

/**
 * Four controls that collected a value and threw it away.
 *
 * Each of these is the same shape of bug: the field is rendered, the
 * user fills it in, the save reports success, and the value never left
 * the browser -- or in one case never even left the input, because the
 * onChange was `() => {}`.
 */
describe('a field you fill in reaches the server', () => {
  describe('adding a model provider', () => {
    const base = { name: 'OpenAI', type: 'openai', apiKey: 'sk-test' } as any

    it('forwards the visibility the picker was set to', () => {
      const body = buildProviderCreateBody({ ...base, visibility: 'team', teamId: 'team-1' })

      expect(body.visibility).toBe('team')
      expect(body.teamId).toBe('team-1')
    })

    it('leaves them out entirely when the picker was not used', () => {
      const body = buildProviderCreateBody(base)

      expect('visibility' in body).toBe(false)
      expect('teamId' in body).toBe(false)
    })

    it('forwards teamId null when switching back to org-wide', () => {
      const body = buildProviderCreateBody({ ...base, visibility: 'org', teamId: null })

      expect(body.visibility).toBe('org')
      expect(body.teamId).toBeNull()
    })
  })
})
