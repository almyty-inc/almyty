import { describe, it, expect } from 'vitest'
import {
  HOSTED_DEFAULT_SETTINGS,
  filesKeptUntil,
  isPlainHost,
  machineStatus,
  ownWorkspace,
  parseAllowedSites,
  readHostedSettings,
  type HostedWorkspace,
} from '../hosted-shared'

const ws = (over: Partial<HostedWorkspace>): HostedWorkspace => ({
  id: 'w1',
  ownerUserId: 'me',
  agentId: null,
  environmentId: 'e1',
  status: 'active',
  lastActiveAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  machine: { id: 'h1', state: 'ready', lastActiveAt: null, lastError: null },
  ...over,
})

describe('machineStatus', () => {
  it('names the four states people see from the machine state', () => {
    expect(machineStatus(ws({}))).toBe('running')
    expect(machineStatus(ws({ machine: { id: 'h', state: 'pending', lastActiveAt: null, lastError: null } }))).toBe('waking')
    expect(machineStatus(ws({ machine: { id: 'h', state: 'provisioning', lastActiveAt: null, lastError: null } }))).toBe('waking')
    expect(machineStatus(ws({ status: 'suspended', machine: { id: 'h', state: 'suspended', lastActiveAt: null, lastError: null } }))).toBe('parked')
    expect(machineStatus(ws({ machine: { id: 'h', state: 'suspending', lastActiveAt: null, lastError: null } }))).toBe('parked')
    expect(machineStatus(ws({ machine: { id: 'h', state: 'failed', lastActiveAt: null, lastError: 'boom' } }))).toBe('failed')
  })

  it('calls a let-go or expired workspace released, whatever its machine says', () => {
    expect(machineStatus(ws({ status: 'released' }))).toBe('released')
    expect(machineStatus(ws({ status: 'expired' }))).toBe('released')
    expect(machineStatus(ws({ machine: { id: 'h', state: 'torn_down', lastActiveAt: null, lastError: null } }))).toBe('released')
  })

  it('treats a workspace with no machine row as parked', () => {
    expect(machineStatus(ws({ status: 'suspended', machine: null }))).toBe('parked')
  })
})

describe('filesKeptUntil', () => {
  it('is the last use plus the retention window', () => {
    expect(filesKeptUntil(ws({}), 30).toISOString()).toBe('2026-10-31T00:00:00.000Z')
  })
  it('counts from creation when it was never used', () => {
    expect(filesKeptUntil(ws({ lastActiveAt: null }), 10).toISOString()).toBe('2026-09-11T00:00:00.000Z')
  })
})

describe('readHostedSettings', () => {
  it('falls back to the shipped defaults when the API sends none', () => {
    expect(readHostedSettings(undefined)).toEqual(HOSTED_DEFAULT_SETTINGS)
  })
  it('takes images as a list or as the settings map, and bounds that hold together', () => {
    const s = readHostedSettings({ images: { slim: 'x', gpu: 'y' }, idleTimeoutMinutes: { min: 1, max: 60, default: 10 }, suspendedRetention: { keepDays: 7 } })
    expect(s.images).toEqual(['slim', 'gpu'])
    expect(s.idleTimeoutMinutes).toEqual({ min: 1, max: 60, default: 10 })
    expect(s.suspendedRetention.keepDays).toBe(7)
    expect(readHostedSettings({ images: ['a'] }).images).toEqual(['a'])
  })
  it('ignores bounds that do not hold together', () => {
    expect(readHostedSettings({ idleTimeoutMinutes: { min: 50, max: 10, default: 20 } }).idleTimeoutMinutes).toEqual(HOSTED_DEFAULT_SETTINGS.idleTimeoutMinutes)
  })
})

describe('allowed sites', () => {
  it('splits on lines, commas and spaces, lower-cases and drops repeats', () => {
    expect(parseAllowedSites('GitHub.com\nregistry.npmjs.org, github.com  pypi.org\n')).toEqual(['github.com', 'registry.npmjs.org', 'pypi.org'])
  })
  it('accepts plain host names only', () => {
    expect(isPlainHost('registry.npmjs.org')).toBe(true)
    for (const bad of ['*.github.com', 'https://github.com', 'github.com/x', '10.0.0.1', 'localhost', 'github.com:443']) {
      expect(isPlainHost(bad)).toBe(false)
    }
  })
})

describe('ownWorkspace', () => {
  it("picks the caller's own live workspace, not an agent's or someone else's", () => {
    const rows = [
      ws({ id: 'agent', agentId: 'a1' }),
      ws({ id: 'other', ownerUserId: 'them' }),
      ws({ id: 'gone', status: 'released' }),
      ws({ id: 'mine' }),
    ]
    expect(ownWorkspace(rows, 'me')?.id).toBe('mine')
    expect(ownWorkspace(rows, undefined)).toBeUndefined()
  })
})
