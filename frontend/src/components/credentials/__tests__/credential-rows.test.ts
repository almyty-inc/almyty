import { describe, it, expect } from 'vitest'

import { credentialRows, managedUse, storedRow } from '../credential-rows'
import type { Connection } from '@/types/connections'

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'c1',
  name: 'GitHub',
  connectorKey: 'github',
  connectorDisplayName: 'GitHub',
  kind: 'tool_source',
  owner: 'org',
  health: { status: 'valid' },
  createdAt: '2026-09-02T00:00:00.000Z',
  ...overrides,
})

describe('credentialRows', () => {
  it('lists each credential once, newest first, preferring what the connection list knows', () => {
    const rows = credentialRows(
      [connection(), connection({ id: 'c2', name: 'OpenAI', connectorKey: 'openai', connectorDisplayName: 'OpenAI', kind: 'inference', createdAt: '2026-09-03T00:00:00.000Z' })],
      [
        { id: 'c1', name: 'GitHub', type: 'api_key', connectorKey: 'github' },
        { id: 's1', name: 'Petstore key', type: 'bearer_token', connectorKey: null, createdAt: '2026-09-01T00:00:00.000Z', metadata: { managedBy: { kind: 'api', id: 'api-1' } } },
      ],
    )
    expect(rows.map((r) => [r.id, r.group, r.service])).toEqual([
      ['c2', 'models', 'OpenAI'],
      ['c1', 'other', 'GitHub'],
      ['s1', 'other', 'Bearer token'],
    ])
  })

  it('says "Saved" for a key nobody can check, as the credential page does', () => {
    const [row] = credentialRows([connection({ connectorKey: 'other' })], [], [{ key: 'other', kind: 'tool_source', displayName: 'Other service', connect: [], validation: { kind: 'format' } }])
    expect(row.check).toMatchObject({ state: 'ok', label: 'Saved' })
  })

  it('keeps someone else\'s private credential hidden when only the stored list has it', () => {
    const rows = credentialRows([], [{ id: 'x', name: 'Their key', type: 'api_key', connectorKey: 'github' }])
    expect(rows).toEqual([])
  })

  it('puts a model provider\'s own key with the model providers, opening the provider', () => {
    const row = storedRow({ id: 'llm-p1', name: 'OpenAI API Key', type: 'api_key', _source: 'llm_provider', _sourceId: 'p1', usedBy: [{ type: 'llm_provider', id: 'p1', name: 'OpenAI' }] })
    expect(row).toMatchObject({ group: 'models', href: '/models/providers/p1', uses: [{ label: 'OpenAI', href: '/models/providers/p1' }] })
  })
})

describe('managedUse', () => {
  it('says what keeps a key of its own, and links to it', () => {
    expect(managedUse({ kind: 'api', id: 'a1' })).toEqual({ label: 'An API', href: '/apis/a1' })
    expect(managedUse({ kind: 'mcp_source', id: 'm1' })).toEqual({ label: 'An MCP server', href: '/tools' })
    expect(managedUse({ kind: 'gateway_channel', id: 'g1' })).toEqual({ label: 'A channel', href: '/gateways/g1' })
    expect(managedUse({ kind: 'something-new' })).toBeNull()
    expect(managedUse(null)).toBeNull()
  })
})
