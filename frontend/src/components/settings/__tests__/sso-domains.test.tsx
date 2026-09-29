import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { SsoDomains } from '../sso-domains'
import { ssoApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  ssoApi: {
    listDomains: vi.fn(),
    addDomain: vi.fn(),
    verifyDomain: vi.fn(),
    removeDomain: vi.fn(),
  },
}))
vi.mock('@/lib/clipboard', () => ({ useCopy: () => vi.fn(), useCopySensitive: () => vi.fn() }))

const WAIT = { timeout: 10000 }

const pending = {
  id: 'd-1',
  domain: 'example.com',
  status: 'pending',
  verifiedAt: null,
  lastCheckedAt: null,
  lastError: null,
  record: { type: 'TXT', name: '_almyty-verify.example.com', value: 'almyty-domain-verification=abc123' },
}

/**
 * Settings > People and access > Single sign-on: an admin adds an email
 * domain, sees the TXT record to publish and the domain's status, and
 * checks it, all inline.
 */
describe('SSO email domains', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a pending domain with the TXT record to publish, and checks it', async () => {
    vi.mocked(ssoApi.listDomains).mockResolvedValueOnce([pending]).mockResolvedValue([{ ...pending, status: 'verified', verifiedAt: '2026-09-29T10:00:00Z' }])
    vi.mocked(ssoApi.verifyDomain).mockResolvedValue({ ...pending, status: 'verified' })
    render(<SsoDomains />)

    const row = await screen.findByRole('listitem', { name: 'example.com' }, WAIT)
    expect(within(row).getByText('Waiting for DNS')).toBeInTheDocument()
    expect(within(row).getByText('_almyty-verify.example.com')).toBeInTheDocument()
    expect(within(row).getByText('almyty-domain-verification=abc123')).toBeInTheDocument()

    fireEvent.click(within(row).getByRole('button', { name: 'Check DNS' }))
    await waitFor(() => expect(ssoApi.verifyDomain).toHaveBeenCalledWith('d-1'), WAIT)
    expect(await screen.findByText('Verified', {}, WAIT)).toBeInTheDocument()
  })

  it('adds a domain from the inline form', async () => {
    vi.mocked(ssoApi.listDomains).mockResolvedValueOnce([]).mockResolvedValue([pending])
    vi.mocked(ssoApi.addDomain).mockResolvedValue(pending)
    render(<SsoDomains />)

    await screen.findByText('No domains yet.', {}, WAIT)
    fireEvent.change(screen.getByLabelText('Add a domain'), { target: { value: 'example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }))

    await waitFor(() => expect(ssoApi.addDomain).toHaveBeenCalledWith('example.com'), WAIT)
    expect(await screen.findByText('_almyty-verify.example.com', {}, WAIT)).toBeInTheDocument()
  })

  it('says why a check failed', async () => {
    vi.mocked(ssoApi.listDomains).mockResolvedValue([{ ...pending, status: 'failed', lastError: 'No TXT record found at that name yet.' }])
    render(<SsoDomains />)

    expect(await screen.findByText('No TXT record found at that name yet.', {}, WAIT)).toBeInTheDocument()
    expect(screen.getByText('Not verified')).toBeInTheDocument()
  })
})
