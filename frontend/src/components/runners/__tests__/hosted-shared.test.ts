import { describe, it, expect } from 'vitest'
import {
  filesKeptUntil,
  formatMinutes,
  isPlainHost,
  machineStatus,
  parseAllowedSites,
  readHostedSettings,
} from '../hosted-shared'

const machine = (state: string, replicas = 1) => ({ id: 'h', state: state as any, desired: { replicas }, lastActiveAt: null, lastError: null })

describe('machineStatus', () => {
  it('names the states people see from the machine state', () => {
    expect(machineStatus({ status: 'active', machine: machine('ready') })).toBe('running')
    expect(machineStatus({ status: 'suspended', machine: machine('pending', 1) })).toBe('waking')
    expect(machineStatus({ status: 'suspended', machine: machine('provisioning', 1) })).toBe('waking')
    expect(machineStatus({ status: 'suspended', machine: machine('suspended', 0) })).toBe('parked')
    expect(machineStatus({ status: 'active', machine: machine('suspending', 0) })).toBe('parked')
    expect(machineStatus({ status: 'active', machine: machine('failed') })).toBe('failed')
  })

  it('tells a machine nothing has asked for yet from one that is starting (desired.replicas)', () => {
    expect(machineStatus({ status: 'suspended', machine: machine('pending', 0) })).toBe('idle')
    expect(machineStatus({ status: 'suspended', machine: machine('pending', 1) })).toBe('waking')
  })

  it('calls a let-go or expired workspace released, whatever its machine says', () => {
    expect(machineStatus({ status: 'released', machine: machine('ready') })).toBe('released')
    expect(machineStatus({ status: 'expired', machine: null })).toBe('released')
    expect(machineStatus({ status: 'active', machine: machine('torn_down') })).toBe('released')
  })

  it('treats a workspace with no machine row as parked', () => {
    expect(machineStatus({ status: 'suspended', machine: null })).toBe('parked')
  })
})

describe('filesKeptUntil', () => {
  it('is the last use plus the retention window', () => {
    expect(filesKeptUntil({ lastActiveAt: '2026-10-01T00:00:00.000Z' }, 30).toISOString()).toBe('2026-10-31T00:00:00.000Z')
  })
  it('counts from creation when it was never used', () => {
    expect(filesKeptUntil({ lastActiveAt: null, createdAt: '2026-09-01T00:00:00.000Z' }, 10).toISOString()).toBe('2026-09-11T00:00:00.000Z')
  })
})

describe('readHostedSettings', () => {
  const sent = { images: ['standard', 'standard-browser'], idleTimeoutMinutes: { min: 5, max: 120, default: 15 }, suspendedRetention: { keepDays: 30, noticeDay: 23 } }

  it('takes the choices the server sends', () => {
    expect(readHostedSettings(sent)).toEqual({ images: ['standard', 'standard-browser'], idleTimeoutMinutes: { min: 5, max: 120, default: 15 }, suspendedRetention: { keepDays: 30 } })
    expect(readHostedSettings({ ...sent, images: { slim: 'x' } })?.images).toEqual(['slim'])
  })

  it('invents nothing: no settings, or settings that do not hold together, give null', () => {
    expect(readHostedSettings(undefined)).toBeNull()
    expect(readHostedSettings({ ...sent, images: [] })).toBeNull()
    expect(readHostedSettings({ ...sent, idleTimeoutMinutes: { min: 50, max: 10, default: 20 } })).toBeNull()
    expect(readHostedSettings({ ...sent, suspendedRetention: {} })).toBeNull()
  })
})

describe('formatMinutes', () => {
  it('says machine time plainly', () => {
    expect(formatMinutes(0)).toBe('0 min')
    expect(formatMinutes(41.6)).toBe('42 min')
    expect(formatMinutes(185)).toBe('3 h 5 min')
    expect(formatMinutes(120)).toBe('2 h')
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
