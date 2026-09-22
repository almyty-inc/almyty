import { describe, it, expect } from 'vitest'

import { createCredentialSchema, credentialConfig } from '../credentials/schema'
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
  describe('vault credentials', () => {
    it('accepts basic auth without demanding a "value" field it never showed', () => {
      const parsed = createCredentialSchema.safeParse({
        name: 'DB login',
        type: 'basic_auth',
        username: 'ada',
        password: 'hunter2',
      })

      expect(parsed.success).toBe(true)
    })

    it('still requires the secret for the single-value types', () => {
      const parsed = createCredentialSchema.safeParse({ name: 'k', type: 'api_key' })

      expect(parsed.success).toBe(false)
      if (!parsed.success) expect(parsed.error.issues[0].message).toMatch(/value is required/i)
    })

    it('asks for the fields the chosen type actually needs', () => {
      const parsed = createCredentialSchema.safeParse({ name: 'oauth', type: 'oauth2' })

      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(parsed.error.issues.map(i => i.path[0])).toEqual(['clientId', 'clientSecret'])
      }
    })

    it('builds the config from whichever fields the type uses', () => {
      expect(credentialConfig({ type: 'basic_auth', username: 'ada', password: 'h2' })).toEqual({
        username: 'ada',
        password: 'h2',
      })
      expect(credentialConfig({ type: 'oauth2', clientId: 'cid', clientSecret: 'sec' })).toEqual({
        clientId: 'cid',
        clientSecret: 'sec',
      })
      expect(credentialConfig({ type: 'api_key', value: 'k' })).toEqual({ value: 'k' })
      // custom carries no secret of its own and must not invent one.
      expect(credentialConfig({ type: 'custom' })).toEqual({})
    })
  })

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
