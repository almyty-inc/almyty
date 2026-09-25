import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '../../../test/setup'

import { CustomDomainCard, type CustomDomainView } from '../custom-domain-card'

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    getCustomDomain: vi.fn(),
    setCustomDomain: vi.fn(),
    verifyCustomDomain: vi.fn(),
    removeCustomDomain: vi.fn(),
  },
}))

import { gatewaysApi } from '@/lib/api'

const GW = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f'

const pending: CustomDomainView = {
  hostname: 'chat.acme.com',
  status: 'pending_verification',
  verifiedAt: null,
  lastCheckedAt: null,
  lastError: null,
  records: {
    txt: { type: 'TXT', name: '_almyty-verify.chat.acme.com', value: 'almyty-domain-verification=abc123' },
    cname: { type: 'CNAME', name: 'chat.acme.com', value: 'acme.almyty.app' },
  },
}

beforeEach(() => {
  vi.mocked(gatewaysApi.getCustomDomain).mockReset()
  vi.mocked(gatewaysApi.setCustomDomain).mockReset()
  vi.mocked(gatewaysApi.verifyCustomDomain).mockReset()
  vi.mocked(gatewaysApi.removeCustomDomain).mockReset()
})

describe('CustomDomainCard', () => {
  it('sets a domain and shows the TXT and CNAME records to publish', async () => {
    vi.mocked(gatewaysApi.getCustomDomain).mockResolvedValue(null)
    vi.mocked(gatewaysApi.setCustomDomain).mockResolvedValue(pending)
    const user = userEvent.setup()
    render(<CustomDomainCard gatewayId={GW} />)

    await user.type(await screen.findByLabelText('Domain'), 'chat.acme.com')
    await user.click(screen.getByRole('button', { name: 'Save domain' }))

    await waitFor(() => expect(gatewaysApi.setCustomDomain).toHaveBeenCalledWith(GW, 'chat.acme.com'))
    expect(await screen.findByText('_almyty-verify.chat.acme.com')).toBeInTheDocument()
    expect(screen.getByText('almyty-domain-verification=abc123')).toBeInTheDocument()
    expect(screen.getByText('acme.almyty.app')).toBeInTheDocument()
    expect(screen.getByText('Waiting for DNS')).toBeInTheDocument()
  })

  it('checks DNS and shows the domain live once verified', async () => {
    vi.mocked(gatewaysApi.getCustomDomain).mockResolvedValue(pending)
    vi.mocked(gatewaysApi.verifyCustomDomain).mockResolvedValue({
      ...pending,
      status: 'active',
      verifiedAt: '2026-09-24T10:00:00Z',
    })
    const user = userEvent.setup()
    render(<CustomDomainCard gatewayId={GW} />)

    await user.click(await screen.findByRole('button', { name: 'Check DNS' }))
    expect(await screen.findByText('Live')).toBeInTheDocument()
    expect(screen.getByText(/Visitors can reach this chat at https:\/\/chat.acme.com/)).toBeInTheDocument()
  })

  it('shows why a check failed and does not claim the domain is live', async () => {
    vi.mocked(gatewaysApi.getCustomDomain).mockResolvedValue(pending)
    vi.mocked(gatewaysApi.verifyCustomDomain).mockResolvedValue({
      ...pending,
      status: 'failed',
      lastError: 'No TXT record found at that name yet.',
    })
    const user = userEvent.setup()
    render(<CustomDomainCard gatewayId={GW} />)

    await user.click(await screen.findByRole('button', { name: 'Check DNS' }))
    expect(await screen.findByText('No TXT record found at that name yet.')).toBeInTheDocument()
    expect(screen.queryByText('Live')).toBeNull()
  })

  it('surfaces a server refusal, such as a domain another surface serves', async () => {
    vi.mocked(gatewaysApi.getCustomDomain).mockResolvedValue(null)
    vi.mocked(gatewaysApi.setCustomDomain).mockRejectedValue({
      response: { status: 409, data: { error: { code: 'DOMAIN_ALREADY_CLAIMED', message: 'Another surface is already serving that domain.' } } },
    })
    const user = userEvent.setup()
    render(<CustomDomainCard gatewayId={GW} />)
    await user.type(await screen.findByLabelText('Domain'), 'chat.taken.com')
    await user.click(screen.getByRole('button', { name: 'Save domain' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already serving/)
  })

  it('removes only after an inline one-line confirm', async () => {
    vi.mocked(gatewaysApi.getCustomDomain).mockResolvedValue(pending)
    vi.mocked(gatewaysApi.removeCustomDomain).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CustomDomainCard gatewayId={GW} />)

    await user.click(await screen.findByRole('button', { name: 'Remove domain' }))
    expect(gatewaysApi.removeCustomDomain).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(gatewaysApi.removeCustomDomain).toHaveBeenCalledWith(GW))
    expect(await screen.findByLabelText('Domain')).toBeInTheDocument()
  })
})

describe('the card is on the app web page', () => {
  it('is rendered inline on the web app page, keyed by its gateway, and on the gateway page only for a surface no app owns', () => {
    const web = readFileSync(join(__dirname, '../../agent-apps/web-place.tsx'), 'utf8')
    expect(web).toMatch(/<CustomDomainCard gatewayId=\{gatewayId\} \/>/)
    const page = readFileSync(join(__dirname, '../../../pages/gateway-detail.tsx'), 'utf8')
    expect(page).toMatch(/gateway\.type === 'hosted_chat' && !managedBy && <CustomDomainCard gatewayId=\{gateway\.id\} \/>/)
    const card = readFileSync(join(__dirname, '../custom-domain-card.tsx'), 'utf8')
    expect(card).not.toMatch(/Dialog/)
  })
})
