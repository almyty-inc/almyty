import { describe, expect, it } from 'vitest'

import { argsFromRows, customCallsTools, customNeedsSecret, emptyCustomForm, specFromCustomForm } from '../custom-push-wake'

describe('the custom push wake form, as a spec', () => {
  it('builds the grouped arguments every API tool takes; a body name with dots nests', () => {
    expect(
      argsFromRows([
        { part: 'path', name: 'calendarId', value: '{{settings.calendarId}}' },
        { part: 'body', name: 'id', value: '{{uuid}}' },
        { part: 'body', name: 'target.url', value: '{{endpoint.url}}' },
        { part: 'query', name: '', value: 'dropped' },
      ]),
    ).toEqual({ path: { calendarId: '{{settings.calendarId}}' }, body: { id: '{{uuid}}', target: { url: '{{endpoint.url}}' } } })
  })

  it('a signed token: issuers, the HTTPS key set, claims', () => {
    const f = { ...emptyCustomForm(), method: 'oidc_jwt' as const, issuers: 'https://a.example, a.example', jwksUrl: 'https://a.example/keys', claims: [{ name: 'email', value: 'push@x.example' }] }
    expect(specFromCustomForm(f).spec?.verification).toEqual({ method: 'oidc_jwt', issuers: ['https://a.example', 'a.example'], jwksUrl: 'https://a.example/keys', claims: { email: 'push@x.example' } })
    expect(specFromCustomForm({ ...f, jwksUrl: 'http://a.example/keys' }).error).toMatch(/HTTPS/)
    expect(customNeedsSecret(f)).toBe(false)
  })

  it('all four steps, and what each needs', () => {
    const base = emptyCustomForm()
    const f = {
      ...base,
      subscribe: { ...base.subscribe, on: true, operation: 'hooks.create', expiresAtPath: 'expiresAt', keep: [{ name: 'hookId', value: 'hook.id' }] },
      renew: { on: true, everyMinutes: '', beforeExpiryMinutes: '60', stopPrevious: true },
      stop: { on: true, operation: 'hooks.delete', args: [{ part: 'path' as const, name: 'id', value: '{{state.subscription.hookId}}' }] },
      changes: { ...base.changes, on: true, operation: 'changes.list', itemsPath: 'changes[*]', cursorPath: 'cursor', resetOnStatus: '410', item: [{ name: 'id', value: 'id' }, { name: 'title', value: 'title' }] },
    }
    expect(customCallsTools(f)).toBe(true)
    expect(specFromCustomForm(f).spec).toMatchObject({
      subscribe: { operation: 'hooks.create', arguments: {}, expiresAtPath: 'expiresAt', keep: { hookId: 'hook.id' } },
      renew: { beforeExpiryMinutes: 60, stopPrevious: true },
      stop: { operation: 'hooks.delete', arguments: { path: { id: '{{state.subscription.hookId}}' } } },
      changes: { operation: 'changes.list', itemsPath: 'changes[*]', cursorPath: 'cursor', resetOnStatus: [410], item: { id: 'id', title: 'title' } },
    })
    expect(specFromCustomForm({ ...f, stop: { ...f.stop, operation: '' } }).error).toBe('Choose the tool for stopping.')
    expect(specFromCustomForm({ ...f, subscribe: { ...f.subscribe, on: false } }).error).toMatch(/needs the subscribe step/)
    expect(specFromCustomForm({ ...f, renew: { ...f.renew, beforeExpiryMinutes: '' } }).error).toMatch(/Say when to renew/)
    expect(specFromCustomForm({ ...f, changes: { ...f.changes, item: [] } }).error).toMatch(/each change/)
  })
})
