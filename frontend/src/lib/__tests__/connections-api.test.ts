import { describe, it, expect, vi, beforeEach } from 'vitest'

import { api } from '../api'
import {
  allowUserScopedConnections,
  bestConnectMethod,
  connectionSettingsApi,
  connectionsApi,
  connectorsApi,
  groupConnectorsByKind,
  isConnectForm,
  isConnectRedirect,
  isCustomConnector,
  isFormMethod,
  isRedirectMethod,
  matchesConnectorSearch,
  matchesPollTarget,
  pollForConnection,
  readValidationFailure,
} from '../connections-api'
import type { Connection, Connector } from '@/types/connections'

function envelope(data: unknown = { ok: true }) {
  return Promise.resolve({ data: { success: true, data } })
}

let getSpy: ReturnType<typeof vi.spyOn>
let postSpy: ReturnType<typeof vi.spyOn>
let patchSpy: ReturnType<typeof vi.spyOn>
let deleteSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  getSpy = vi.spyOn(api, 'get').mockImplementation(() => envelope() as any)
  postSpy = vi.spyOn(api, 'post').mockImplementation(() => envelope() as any)
  patchSpy = vi.spyOn(api, 'patch').mockImplementation(() => envelope() as any)
  deleteSpy = vi.spyOn(api, 'delete').mockImplementation(() => envelope() as any)
})

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    name: 'OpenAI',
    connectorKey: 'openai',
    kind: 'inference',
    owner: 'org',
    health: { status: 'valid' },
    createdAt: '2026-09-08T10:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z',
    ...overrides,
  }
}

describe('connectorsApi', () => {
  it('lists connectors, optionally by kind, and creates a custom one', async () => {
    await connectorsApi.list()
    expect(getSpy).toHaveBeenCalledWith('/connectors', undefined)
    await connectorsApi.list('mcp')
    expect(getSpy).toHaveBeenLastCalledWith('/connectors', { params: { kind: 'mcp' } })

    const body = { key: 'my-vllm', kind: 'inference' as const, displayName: 'Office vLLM', connect: [{ type: 'api_key' as const, label: 'API key' }], validation: { kind: 'http' as const, url: 'https://x/v1/models' } }
    await connectorsApi.create(body)
    expect(postSpy).toHaveBeenCalledWith('/connectors', body, undefined)
  })
})

describe('connectionsApi', () => {
  it('lists and unwraps the envelope', async () => {
    getSpy.mockImplementation(() => envelope([{ id: 'c1', name: 'OpenAI' }]) as any)
    await expect(connectionsApi.list()).resolves.toEqual([{ id: 'c1', name: 'OpenAI' }])
    expect(getSpy).toHaveBeenCalledWith('/connections', undefined)
  })

  it('posts connect with the method, owner and input', async () => {
    await connectionsApi.connect('openai', { method: 'api_key', owner: 'org', input: { apiKey: 'sk-1' } })
    expect(postSpy).toHaveBeenCalledWith('/connections/connect/openai', { method: 'api_key', owner: 'org', input: { apiKey: 'sk-1' } }, undefined)
  })

  it('url-encodes the connector key', async () => {
    await connectionsApi.connect('acme/mcp', { owner: 'user' })
    expect(postSpy).toHaveBeenCalledWith('/connections/connect/acme%2Fmcp', { owner: 'user' }, undefined)
  })

  it('completes a headless flow and returns the connection whether bare or wrapped', async () => {
    postSpy.mockImplementation(() => envelope({ id: 'c1', name: 'Slack' }) as any)
    await expect(connectionsApi.complete('slack', { state: 'st-1', code: 'abc' })).resolves.toEqual({ id: 'c1', name: 'Slack' })
    expect(postSpy).toHaveBeenCalledWith('/connections/connect/slack/complete', { state: 'st-1', code: 'abc' }, undefined)

    postSpy.mockImplementation(() => envelope({ connection: { id: 'c2' } }) as any)
    await expect(connectionsApi.complete('slack', { state: 'st-1', code: 'abc' })).resolves.toEqual({ id: 'c2' })
  })

  it('gets, validates, rotates and removes by id', async () => {
    await connectionsApi.get('c1')
    expect(getSpy).toHaveBeenCalledWith('/connections/c1', undefined)

    postSpy.mockImplementation(() => envelope({ id: 'c1', health: { status: 'valid' } }) as any)
    await expect(connectionsApi.validate('c1')).resolves.toEqual({ id: 'c1', health: { status: 'valid' } })
    expect(postSpy).toHaveBeenCalledWith('/connections/c1/validate', undefined, undefined)

    await connectionsApi.rotate('c1', { input: { apiKey: 'sk-2' } })
    expect(postSpy).toHaveBeenCalledWith('/connections/c1/rotate', { input: { apiKey: 'sk-2' } }, undefined)
    await connectionsApi.rotate('c1')
    expect(postSpy).toHaveBeenLastCalledWith('/connections/c1/rotate', {}, undefined)

    await connectionsApi.remove('c1')
    expect(deleteSpy).toHaveBeenCalledWith('/connections/c1', undefined)
  })

  it('lists, adds and removes grants', async () => {
    await connectionsApi.listGrants('c1')
    expect(getSpy).toHaveBeenCalledWith('/connections/c1/grants', undefined)
    await connectionsApi.addGrant('c1', { principalType: 'team', principalId: 't1', permission: 'use' })
    expect(postSpy).toHaveBeenCalledWith('/connections/c1/grants', { principalType: 'team', principalId: 't1', permission: 'use' }, undefined)
    await connectionsApi.removeGrant('c1', 'g1')
    expect(deleteSpy).toHaveBeenCalledWith('/connections/c1/grants/g1', undefined)
  })

  it('patches the org toggle inside settings', async () => {
    await connectionSettingsApi.setAllowUserScopedConnections('org-1', false)
    expect(patchSpy).toHaveBeenCalledWith('/organizations/org-1', { settings: { allowUserScopedConnections: false } }, undefined)
  })
})

describe('helpers', () => {
  const openai: Connector = {
    key: 'openai',
    kind: 'inference',
    displayName: 'OpenAI',
    description: 'GPT models',
    connect: [{ type: 'api_key', label: 'API key' }],
  }
  const slack: Connector = {
    key: 'slack',
    kind: 'channel',
    displayName: 'Slack',
    connect: [{ type: 'oauth2_code', label: 'Add to Slack' }, { type: 'api_key', label: 'Bot token' }],
  }

  it('reads the effective org toggle: explicit setting, else plan default', () => {
    expect(allowUserScopedConnections({ plan: 'enterprise', settings: { allowUserScopedConnections: true } })).toBe(true)
    expect(allowUserScopedConnections({ plan: 'free', settings: { allowUserScopedConnections: false } })).toBe(false)
    expect(allowUserScopedConnections({ plan: 'free', settings: {} })).toBe(true)
    expect(allowUserScopedConnections({ plan: 'pro', settings: null })).toBe(false)
    expect(allowUserScopedConnections(null)).toBe(true)
  })

  it('classifies methods', () => {
    expect(isRedirectMethod('oauth2_pkce')).toBe(true)
    expect(isRedirectMethod('installation')).toBe(true)
    expect(isRedirectMethod('oauth2_client_credentials')).toBe(false)
    expect(isFormMethod('api_key')).toBe(true)
    expect(isFormMethod('cloud_iam')).toBe(true)
    expect(isFormMethod('oauth2_client_credentials')).toBe(true)
    expect(isFormMethod('installation')).toBe(false)
  })

  it('picks the ranked-first method', () => {
    expect(bestConnectMethod(slack)?.type).toBe('oauth2_code')
    expect(bestConnectMethod({ connect: [] })).toBeNull()
    expect(bestConnectMethod(null)).toBeNull()
  })

  it('tells a redirect, a returned form and a finished connection apart', () => {
    const redirect = { pending: true as const, method: 'oauth2_pkce' as const, mode: 'browser' as const, authorizeUrl: 'https://x', state: 's', expiresInSeconds: 600, completeWith: 'callback' as const }
    expect(isConnectRedirect(redirect)).toBe(true)
    expect(isConnectForm(redirect)).toBe(false)
    const form = { pending: true as const, method: 'api_key' as const, form: { schema: undefined, keyPageUrl: null } }
    expect(isConnectForm(form)).toBe(true)
    expect(isConnectRedirect(form)).toBe(false)
    expect(isConnectRedirect({ pending: false, connection: connection() })).toBe(false)
    expect(isConnectRedirect(null)).toBe(false)
  })

  it('marks org-defined connectors as custom', () => {
    expect(isCustomConnector(openai)).toBe(false)
    expect(isCustomConnector({ ...openai, organizationId: 'org-1' })).toBe(true)
  })

  it('reads a validation failure from a flat or enveloped 422', () => {
    const flat = { response: { status: 422, data: { code: 'CONNECTION_VALIDATION_FAILED', message: 'bad key', connection: { id: 'c9' } } } }
    expect(readValidationFailure(flat)).toEqual({ code: 'CONNECTION_VALIDATION_FAILED', message: 'bad key', connection: { id: 'c9' } })

    const wrapped = { response: { status: 422, data: { success: false, error: { code: 'CONNECTION_VALIDATION_FAILED', message: 'expired' } } } }
    expect(readValidationFailure(wrapped)?.message).toBe('expired')

    expect(readValidationFailure({ response: { status: 400, data: { code: 'OTHER', message: 'nope' } } })).toBeNull()
    expect(readValidationFailure(new Error('network'))).toBeNull()
  })

  it('groups connectors in gallery order and drops empty kinds', () => {
    const groups = groupConnectorsByKind([slack, openai], ['inference', 'deployment', 'channel'])
    expect(groups.map((g) => g.kind)).toEqual(['inference', 'channel'])
    expect(groups[0].connectors[0].key).toBe('openai')
  })

  it('matches search on key, name, description and kind', () => {
    expect(matchesConnectorSearch(openai, 'gpt')).toBe(true)
    expect(matchesConnectorSearch(openai, 'INFER')).toBe(true)
    expect(matchesConnectorSearch(openai, 'slack')).toBe(false)
    expect(matchesConnectorSearch(openai, '  ')).toBe(true)
  })

  it('matches a poll target by connector and creation time, or by id and update time for a rotate', () => {
    const since = Date.parse('2026-09-08T09:59:00.000Z')
    expect(matchesPollTarget(connection(), { connectorKey: 'openai', since })).toBe(true)
    expect(matchesPollTarget(connection({ createdAt: '2026-09-08T09:00:00.000Z' }), { connectorKey: 'openai', since })).toBe(false)
    expect(matchesPollTarget(connection({ connectorKey: 'slack' }), { connectorKey: 'openai', since })).toBe(false)
    expect(matchesPollTarget(connection({ createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-08T10:00:00.000Z' }), { connectorKey: 'openai', since, connectionId: 'c1' })).toBe(true)
    expect(matchesPollTarget(connection({ updatedAt: '2026-09-08T09:00:00.000Z' }), { connectorKey: 'openai', since, connectionId: 'c1' })).toBe(false)
  })

  it('polls until the matching connection appears, riding out a listing error', async () => {
    const since = Date.parse('2026-09-08T09:59:00.000Z')
    getSpy
      .mockImplementationOnce(() => envelope([connection({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' })]) as any)
      .mockImplementationOnce(() => Promise.reject(new Error('blip')) as any)
      .mockImplementationOnce(() => envelope([connection({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' }), connection({ id: 'new' })]) as any)
    const wait = vi.fn().mockResolvedValue(undefined)
    const found = await pollForConnection({ connectorKey: 'openai', since }, { wait, intervalMs: 5 })
    expect(found?.id).toBe('new')
    expect(getSpy).toHaveBeenCalledTimes(3)
    expect(getSpy).toHaveBeenCalledWith('/connections', undefined)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('gives up on abort', async () => {
    getSpy.mockImplementation(() => envelope([]) as any)
    const controller = new AbortController()
    const wait = vi.fn().mockImplementation(async () => { controller.abort() })
    const found = await pollForConnection({ connectorKey: 'openai', since: 0 }, { wait, signal: controller.signal })
    expect(found).toBeNull()
    expect(getSpy).toHaveBeenCalledTimes(1)
  })
})
