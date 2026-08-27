import { describe, it, expect } from 'vitest'

import { appSlugError, slugify } from '../create-app-dialog'

describe('slugify', () => {
  it('turns a display name into a usable address', () => {
    expect(slugify('Acme Support')).toBe('acme-support')
    expect(slugify('  Acme   Support  ')).toBe('acme-support')
  })

  it('drops characters that cannot appear in a hostname', () => {
    expect(slugify('Acme & Co. Support!')).toBe('acme-co-support')
  })

  it('never leaves a leading or trailing hyphen', () => {
    // Those are the two forms a hostname label cannot take.
    expect(slugify('!!!Acme!!!')).toBe('acme')
    expect(slugify('-Acme-')).toBe('acme')
  })

  it('caps at the hostname label limit', () => {
    expect(slugify('a'.repeat(120)).length).toBe(63)
  })

  it('returns empty for a name with nothing usable in it', () => {
    expect(slugify('!!!')).toBe('')
  })
})

describe('appSlugError', () => {
  it('accepts a usable address', () => {
    expect(appSlugError('acme-support')).toBeNull()
    expect(appSlugError('a1b2')).toBeNull()
  })

  it('explains each way an address is unusable', () => {
    expect(appSlugError('')).toMatch(/Pick a name/)
    expect(appSlugError('ab')).toMatch(/at least 3/)
    expect(appSlugError('a'.repeat(64))).toMatch(/63 characters/)
    expect(appSlugError('-acme')).toMatch(/cannot start or end/)
    expect(appSlugError('acme-')).toMatch(/cannot start or end/)
    expect(appSlugError('Acme Support')).toMatch(/lowercase/)
    expect(appSlugError('acme_support')).toMatch(/lowercase/)
  })

  it('refuses names the platform routes itself', () => {
    for (const reserved of ['www', 'api', 'app', 'docs', 'download']) {
      expect(appSlugError(reserved)).toMatch(/reserved/)
    }
  })

  it('matches what slugify produces, so the default never fails validation', () => {
    // If these disagreed, typing a normal product name would produce an
    // address the form immediately rejects.
    for (const name of ['Acme Support', 'Northwind AI', 'Support Bot 2']) {
      expect(appSlugError(slugify(name))).toBeNull()
    }
  })
})
