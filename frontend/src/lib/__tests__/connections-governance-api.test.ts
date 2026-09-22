import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { api } from '../api'
import {
  buildCreatePolicyBody,
  buildPolicyRule,
  buildUpdatePolicyBody,
  connectionPoliciesApi,
  connectionsAuditExportApi,
  connectionsExpiryApi,
  connectionsReviewApi,
  connectionsRotationApi,
  daysUntil,
  describePolicyRule,
  emptyPolicyForm,
  exportFilename,
  isConnectorListRule,
  isExpiryRule,
  isRotationRule,
  isScopeRule,
  policyToForm,
  readPolicyInvalid,
  validatePolicyForm,
} from '../connections-governance-api'
import type { ConnectionPolicy } from '@/types/connections-governance'

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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('connectionPoliciesApi', () => {
  it('lists, gets, creates, updates and removes under /ee/connections/policies', async () => {
    await connectionPoliciesApi.list()
    expect(getSpy).toHaveBeenCalledWith('/ee/connections/policies', undefined)
    await connectionPoliciesApi.get('p1')
    expect(getSpy).toHaveBeenLastCalledWith('/ee/connections/policies/p1', undefined)
    await connectionPoliciesApi.create({ kind: 'expiry_rule', rule: { maxAgeDays: 90, warnDays: 7, enforce: true } })
    expect(postSpy).toHaveBeenCalledWith('/ee/connections/policies', { kind: 'expiry_rule', rule: { maxAgeDays: 90, warnDays: 7, enforce: true } }, undefined)
    await connectionPoliciesApi.update('p1', { enabled: false })
    expect(patchSpy).toHaveBeenCalledWith('/ee/connections/policies/p1', { enabled: false }, undefined)
    await connectionPoliciesApi.remove('p1')
    expect(deleteSpy).toHaveBeenCalledWith('/ee/connections/policies/p1', undefined)
  })

  it('unwraps the envelope', async () => {
    getSpy.mockImplementation(() => envelope([{ id: 'p1', kind: 'expiry_rule' }]) as any)
    await expect(connectionPoliciesApi.list()).resolves.toEqual([{ id: 'p1', kind: 'expiry_rule' }])
  })
})

describe('review, expiry, rotation', () => {
  it('lists the review, filtering by environment only when asked', async () => {
    await connectionsReviewApi.list()
    expect(getSpy).toHaveBeenCalledWith('/ee/connections/review', undefined)
    await connectionsReviewApi.list('production')
    expect(getSpy).toHaveBeenLastCalledWith('/ee/connections/review', { params: { environment: 'production' } })
  })

  it('revokes grants with the default principal types unless given', async () => {
    await connectionsReviewApi.revokeGrants('c1')
    expect(postSpy).toHaveBeenCalledWith('/ee/connections/review/c1/revoke-grants', {}, undefined)
    await connectionsReviewApi.revokeGrants('c1', ['agent'])
    expect(postSpy).toHaveBeenLastCalledWith('/ee/connections/review/c1/revoke-grants', { principalTypes: ['agent'] }, undefined)
  })

  it('reads and triggers expiry and rotation', async () => {
    await connectionsExpiryApi.list()
    expect(getSpy).toHaveBeenCalledWith('/ee/connections/expiring', undefined)
    await connectionsExpiryApi.enforce()
    expect(postSpy).toHaveBeenCalledWith('/ee/connections/expiring/enforce', undefined, undefined)
    await connectionsRotationApi.candidates()
    expect(getSpy).toHaveBeenLastCalledWith('/ee/connections/rotate-due', undefined)
    await connectionsRotationApi.rotateDue()
    expect(postSpy).toHaveBeenLastCalledWith('/ee/connections/rotate-due', undefined, undefined)
  })
})

describe('connectionsAuditExportApi', () => {
  it('fetches a blob with the format and hands it to the browser download', async () => {
    const createObjectURL = vi.fn(() => 'blob:x')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    getSpy.mockImplementation(() =>
      Promise.resolve({
        data: new Blob(['id,createdAt'], { type: 'text/csv' }),
        headers: { 'content-disposition': 'attachment; filename="connections-audit-2026-09-08.csv"', 'x-audit-export-count': '12', 'x-audit-retention-days': 'unlimited' },
      }) as any,
    )

    const result = await connectionsAuditExportApi.download('csv', { from: '2026-01-01T00:00:00.000Z', limit: 100 })

    expect(getSpy).toHaveBeenCalledWith('/ee/connections/audit-export', { params: { format: 'csv', from: '2026-01-01T00:00:00.000Z', limit: '100' }, responseType: 'blob' })
    expect(result).toEqual({ filename: 'connections-audit-2026-09-08.csv', count: 12, retentionDays: 'unlimited' })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })

  it('falls back to a default filename and null counters', async () => {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:y', configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    getSpy.mockImplementation(() => Promise.resolve({ data: new Blob(['{}']), headers: {} }) as any)
    await expect(connectionsAuditExportApi.download('json')).resolves.toEqual({ filename: 'connections-audit.json', count: null, retentionDays: null })
  })

  it('reads the filename from a Content-Disposition header', () => {
    expect(exportFilename('attachment; filename="a b.json"', 'x.json')).toBe('a b.json')
    expect(exportFilename('attachment; filename=plain.csv', 'x.csv')).toBe('plain.csv')
    expect(exportFilename(undefined, 'x.csv')).toBe('x.csv')
  })
})

describe('policy form <-> rule', () => {
  it('builds a connector allow list, with owners only when one is ticked', () => {
    const form = { ...emptyPolicyForm('connector_allowlist'), connectorKeys: [' openai', 'anthropic', 'openai'], owners: ['org' as const] }
    expect(buildPolicyRule(form)).toEqual({ connectorKeys: ['openai', 'anthropic'], owners: ['org'] })
    expect(buildPolicyRule({ ...form, owners: ['org', 'user'] })).toEqual({ connectorKeys: ['openai', 'anthropic'] })
    expect(buildPolicyRule({ ...form, kind: 'connector_denylist', owners: [] })).toEqual({ connectorKeys: ['openai', 'anthropic'] })
  })

  it('builds a scope rule with lowercased environments and the fixed owner', () => {
    const form = { ...emptyPolicyForm('scope_rule'), principalKinds: ['agent' as const, 'workspace' as const, 'agent' as const], environments: ['Production', ' staging '], approvedConnectorsOnly: true }
    expect(buildPolicyRule(form)).toEqual({ principalKinds: ['agent', 'workspace'], environments: ['production', 'staging'], requireOwner: 'org', approvedConnectorsOnly: true })
    expect(buildPolicyRule({ ...form, environments: [], approvedConnectorsOnly: false })).toEqual({ principalKinds: ['agent', 'workspace'], requireOwner: 'org' })
  })

  it('builds expiry and rotation rules with the defaults', () => {
    expect(buildPolicyRule(emptyPolicyForm('expiry_rule'))).toEqual({ maxAgeDays: 90, warnDays: 7, enforce: true })
    expect(buildPolicyRule(emptyPolicyForm('rotation_rule'))).toEqual({ everyDays: 90, requireProviderApi: true })
    expect(buildPolicyRule({ ...emptyPolicyForm('rotation_rule'), everyDays: 30, connectorKeys: ['openai'] })).toEqual({ everyDays: 30, requireProviderApi: true, connectorKeys: ['openai'] })
  })

  it('builds the create and update bodies, dropping a blank name', () => {
    const form = { ...emptyPolicyForm('expiry_rule'), name: '  ' }
    expect(buildCreatePolicyBody(form)).toEqual({ kind: 'expiry_rule', name: null, rule: { maxAgeDays: 90, warnDays: 7, enforce: true }, enabled: true })
    expect(buildUpdatePolicyBody({ ...form, name: 'Quarterly' })).toEqual({ name: 'Quarterly', rule: { maxAgeDays: 90, warnDays: 7, enforce: true } })
  })

  it('round-trips a stored policy through the form', () => {
    const allow: ConnectionPolicy = { id: 'p1', kind: 'connector_allowlist', name: 'Approved', rule: { connectorKeys: ['openai'], owners: ['user'] }, enabled: true, createdBy: null, createdAt: '', updatedAt: '' }
    expect(buildPolicyRule(policyToForm(allow))).toEqual(allow.rule)
    const scope: ConnectionPolicy = { ...allow, kind: 'scope_rule', name: null, rule: { principalKinds: ['agent'], environments: ['production'], requireOwner: 'org', approvedConnectorsOnly: true } }
    expect(buildPolicyRule(policyToForm(scope))).toEqual(scope.rule)
    const expiry: ConnectionPolicy = { ...allow, kind: 'expiry_rule', rule: { maxAgeDays: 30, warnDays: 3, enforce: false } }
    expect(buildPolicyRule(policyToForm(expiry))).toEqual(expiry.rule)
    const rotation: ConnectionPolicy = { ...allow, kind: 'rotation_rule', rule: { everyDays: 14, requireProviderApi: true } }
    expect(buildPolicyRule(policyToForm(rotation))).toEqual(rotation.rule)
    expect(policyToForm(rotation).name).toBe('Approved')
  })

  it('validates per kind like the server', () => {
    expect(validatePolicyForm(emptyPolicyForm('connector_allowlist'))).toEqual(['Pick at least one connector'])
    expect(validatePolicyForm({ ...emptyPolicyForm('scope_rule'), principalKinds: [] })).toEqual(['Pick at least one principal kind'])
    expect(validatePolicyForm({ ...emptyPolicyForm('expiry_rule'), warnDays: 90 })).toEqual(['Warning must come before the maximum age'])
    expect(validatePolicyForm({ ...emptyPolicyForm('expiry_rule'), maxAgeDays: 0 })).toEqual(['Maximum age must be a whole number of days, at least 1'])
    expect(validatePolicyForm({ ...emptyPolicyForm('rotation_rule'), everyDays: 0 })).toEqual(['Rotation interval must be a whole number of days, at least 1'])
    expect(validatePolicyForm(emptyPolicyForm('rotation_rule'))).toEqual([])
  })

  it('type guards tell the rules apart', () => {
    expect(isConnectorListRule({ connectorKeys: ['a'] })).toBe(true)
    expect(isConnectorListRule({ connectorKeys: ['a'], everyDays: 3, requireProviderApi: true })).toBe(false)
    expect(isRotationRule({ connectorKeys: ['a'], everyDays: 3, requireProviderApi: true })).toBe(true)
    expect(isScopeRule({ principalKinds: ['agent'], requireOwner: 'org' })).toBe(true)
    expect(isExpiryRule({ maxAgeDays: 1, warnDays: 0, enforce: false })).toBe(true)
  })
})

describe('describePolicyRule', () => {
  const names = { openai: 'OpenAI', anthropic: 'Anthropic' }

  it('says what each kind does in words', () => {
    expect(describePolicyRule({ kind: 'connector_allowlist', rule: { connectorKeys: ['openai', 'anthropic'], owners: ['org'] } }, names)).toBe('Organization connections may only use OpenAI, Anthropic')
    expect(describePolicyRule({ kind: 'connector_denylist', rule: { connectorKeys: ['openrouter'], owners: ['user'] } }, names)).toBe('Personal connections may never use openrouter')
    expect(describePolicyRule({ kind: 'connector_denylist', rule: { connectorKeys: ['openrouter'] } })).toBe('All connections may never use openrouter')
    expect(describePolicyRule({ kind: 'scope_rule', rule: { principalKinds: ['agent', 'workspace'], environments: ['production'], requireOwner: 'org', approvedConnectorsOnly: true } })).toBe('Agents, Workspaces in production may only use organization connections from approved connectors')
    expect(describePolicyRule({ kind: 'scope_rule', rule: { principalKinds: ['agent'], requireOwner: 'org' } })).toBe('Agents may only use organization connections')
    expect(describePolicyRule({ kind: 'expiry_rule', rule: { maxAgeDays: 90, warnDays: 7, enforce: true } })).toBe('Secrets expire after 90 days, warning 7 days ahead, grants are revoked on expiry')
    expect(describePolicyRule({ kind: 'expiry_rule', rule: { maxAgeDays: 30, warnDays: 1, enforce: false } })).toBe('Secrets expire after 30 days, warning 1 day ahead, owners are notified only')
    expect(describePolicyRule({ kind: 'rotation_rule', rule: { everyDays: 30, requireProviderApi: true, connectorKeys: ['openai'] } }, names)).toBe('Rotate OpenAI every 30 days through the provider API')
    expect(describePolicyRule({ kind: 'rotation_rule', rule: { everyDays: 90, requireProviderApi: true } })).toBe('Rotate every connector every 90 days through the provider API')
  })

  it('truncates long connector lists', () => {
    expect(describePolicyRule({ kind: 'connector_allowlist', rule: { connectorKeys: ['a', 'b', 'c', 'd', 'e', 'f'] } })).toBe('All connections may only use a, b, c, d and 2 more')
  })
})

describe('readPolicyInvalid', () => {
  it('reads the 400 body in both envelope shapes', () => {
    const bare = { response: { data: { code: 'CONNECTION_POLICY_INVALID', message: 'warnDays must be smaller than maxAgeDays', errors: ['warnDays must be smaller than maxAgeDays'] } } }
    expect(readPolicyInvalid(bare)).toEqual({ code: 'CONNECTION_POLICY_INVALID', message: 'warnDays must be smaller than maxAgeDays', errors: ['warnDays must be smaller than maxAgeDays'] })
    const wrapped = { response: { data: { success: false, data: { code: 'CONNECTION_POLICY_INVALID', message: 'bad', errors: ['a', 'b'] } } } }
    expect(readPolicyInvalid(wrapped)?.errors).toEqual(['a', 'b'])
    expect(readPolicyInvalid({ response: { data: { code: 'OTHER' } } })).toBeNull()
    expect(readPolicyInvalid(new Error('network'))).toBeNull()
  })
})

describe('daysUntil', () => {
  it('counts whole days, negative when past', () => {
    const now = Date.parse('2026-09-08T00:00:00.000Z')
    expect(daysUntil('2026-09-10T00:00:00.000Z', now)).toBe(2)
    expect(daysUntil('2026-09-07T00:00:00.000Z', now)).toBe(-1)
    expect(daysUntil(null, now)).toBeNull()
    expect(daysUntil('nope', now)).toBeNull()
  })
})
