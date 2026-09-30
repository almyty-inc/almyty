/**
 * Settings > API keys: your own keys in a table (only the first
 * characters), a new one made inline and shown once with copy, and revoke
 * behind a one-line confirm. No dialog but that confirm; the full key never
 * reaches storage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../../test/setup'
import { ApiKeysSettings, expiresAtFromDate, expiryLabel, personalKeysOf } from '../api-keys-settings'
import { authApi } from '../../../lib/api'

vi.mock('../../../lib/api', () => ({
  authApi: { listApiKeys: vi.fn(), createApiKey: vi.fn(), revokeApiKey: vi.fn() },
}))

const KEYS = [
  { id: 'k1', name: 'Laptop', keyPrefix: 'almyty_ab12c', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, expiresAt: null },
  { id: 'k2', name: 'Old CI', keyPrefix: 'almyty_ff00e', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-02-01T00:00:00Z', expiresAt: '2026-03-01T00:00:00Z' },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(authApi.listApiKeys).mockResolvedValue({ apiKeys: KEYS })
})

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('ApiKeysSettings', () => {
  it('lists your keys in a table, by their first characters only', async () => {
    render(<ApiKeysSettings />)
    await screen.findByText('Laptop')
    const table = screen.getByRole('table')
    expect(within(table).getByText('almyty_ab12c...')).toBeInTheDocument()
    for (const header of ['Name', 'Key', 'Created', 'Last used', 'Expires']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    // One never used, one expired.
    expect(within(table).getAllByText('Never').length).toBeGreaterThan(0)
    expect(within(table).getByText('Expired')).toBeInTheDocument()
  })

  it('makes a key inline, shows it once with copy, and never stores it', async () => {
    vi.mocked(authApi.createApiKey).mockResolvedValue({ apiKey: 'almyty_full_secret_value', keyData: { id: 'k9' } })
    render(<ApiKeysSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'New key' }))
    const form = screen.getByRole('form', { name: 'New API key' })
    fireEvent.change(within(form).getByLabelText(/Name/), { target: { value: 'CI' } })
    fireEvent.change(within(form).getByLabelText('Expires'), { target: { value: '2027-01-31' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Make key' }))

    await waitFor(() => expect(authApi.createApiKey).toHaveBeenCalledWith({ name: 'CI', expiresAt: expiresAtFromDate('2027-01-31') }))
    const shown = await screen.findByTestId('generated-api-key')
    expect(within(shown).getByText('almyty_full_secret_value')).toHaveAttribute('data-sensitive-text')
    expect(within(shown).getByRole('button', { name: 'Copy API key' })).toBeInTheDocument()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(JSON.stringify({ ...localStorage })).not.toContain('almyty_full_secret_value')
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('almyty_full_secret_value')

    fireEvent.click(within(shown).getByRole('button', { name: "I've saved it" }))
    expect(screen.queryByText('almyty_full_secret_value')).not.toBeInTheDocument()
  })

  it('asks for a name before making a key', async () => {
    render(<ApiKeysSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'New key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make key' }))
    expect(await screen.findByText('Give the key a name.')).toBeInTheDocument()
    expect(authApi.createApiKey).not.toHaveBeenCalled()
  })

  it('revokes after a one-line confirm naming the key', async () => {
    vi.mocked(authApi.revokeApiKey).mockResolvedValue(null)
    render(<ApiKeysSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Laptop' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Revoke Laptop?')).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke key' }))
    await waitFor(() => expect(authApi.revokeApiKey).toHaveBeenCalledWith('k1'))
  })

  it('does not revoke when the confirm is cancelled', async () => {
    render(<ApiKeysSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Laptop' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(authApi.revokeApiKey).not.toHaveBeenCalled()
  })

  it('says so when there are no keys', async () => {
    vi.mocked(authApi.listApiKeys).mockResolvedValue({ apiKeys: [] })
    render(<ApiKeysSettings />)
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument()
  })

  it('reads the list and the dates as the server sends them', () => {
    expect(personalKeysOf({ apiKeys: KEYS }).map((k) => k.id)).toEqual(['k1', 'k2'])
    expect(personalKeysOf(KEYS)).toHaveLength(2)
    expect(personalKeysOf(null)).toEqual([])
    expect(expiryLabel(null)).toBe('Never')
    expect(expiryLabel('2026-03-01T00:00:00Z', Date.parse('2026-09-30T00:00:00Z'))).toBe('Expired')
    expect(expiresAtFromDate('')).toBeUndefined()
    expect(new Date(expiresAtFromDate('2027-01-31')!).getDate()).toBe(31)
  })

  it('keeps the key out of any storage, in the source too', () => {
    const src = readFileSync(join(__dirname, '..', 'api-keys-settings.tsx'), 'utf8')
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/)
  })
})
