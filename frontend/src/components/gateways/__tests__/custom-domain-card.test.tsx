import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '../../../test/setup'

import { CustomDomainField, type CustomDomainView } from '../custom-domain-card'

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    verifyCustomDomain: vi.fn(),
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

/** The field as the channel page holds it: its value is the page's. */
function Held({ domain, onChange = vi.fn(), error }: { domain: CustomDomainView | null; onChange?: (v: string) => void; error?: string }) {
  const [value, setValue] = useState(domain?.hostname ?? '')
  return (
    <CustomDomainField
      gatewayId={GW}
      domain={domain}
      value={value}
      onChange={(v) => {
        setValue(v)
        onChange(v)
      }}
      error={error}
    />
  )
}

beforeEach(() => {
  vi.mocked(gatewaysApi.verifyCustomDomain).mockReset()
})

describe('CustomDomainField', () => {
  it('is a field of the page, with no save button of its own', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Held domain={null} onChange={onChange} />)
    await user.type(screen.getByLabelText('Domain'), 'chat.acme.com')
    expect(onChange).toHaveBeenLastCalledWith('chat.acme.com')
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    expect(screen.getByText('Save to get the DNS records for it.')).toBeInTheDocument()
  })

  it('shows the saved domain with the TXT and CNAME records to publish', () => {
    render(<Held domain={pending} />)
    expect(screen.getByLabelText('Domain')).toHaveValue('chat.acme.com')
    expect(screen.getByText('_almyty-verify.chat.acme.com')).toBeInTheDocument()
    expect(screen.getByText('almyty-domain-verification=abc123')).toBeInTheDocument()
    expect(screen.getByText('acme.almyty.app')).toBeInTheDocument()
    expect(screen.getByText('Waiting for DNS')).toBeInTheDocument()
  })

  it('checks DNS and shows the domain live once verified', async () => {
    vi.mocked(gatewaysApi.verifyCustomDomain).mockResolvedValue({ ...pending, status: 'active', verifiedAt: '2026-09-24T10:00:00Z' })
    const user = userEvent.setup()
    // The check writes the domain into the query cache the page reads it from.
    const queryClient = new QueryClient()
    render(<Held domain={pending} />, { queryClient })
    await user.click(screen.getByRole('button', { name: 'Check DNS' }))
    expect(gatewaysApi.verifyCustomDomain).toHaveBeenCalledWith(GW)
    await waitFor(() => expect(queryClient.getQueryData(['gateway-custom-domain', GW])).toMatchObject({ status: 'active' }))
  })

  it('shows why the last check failed and does not claim the domain is live', () => {
    render(<Held domain={{ ...pending, status: 'failed', lastError: 'No TXT record found at that name yet.' }} />)
    expect(screen.getByText('No TXT record found at that name yet.')).toBeInTheDocument()
    expect(screen.queryByText('Live')).toBeNull()
  })

  it('says a refusal from the save next to the field', () => {
    render(<Held domain={null} error="Another surface is already serving that domain." />)
    expect(screen.getByText('Another surface is already serving that domain.')).toBeInTheDocument()
  })

  it('hides the old records while a new domain is typed', async () => {
    const user = userEvent.setup()
    render(<Held domain={pending} />)
    await user.clear(screen.getByLabelText('Domain'))
    await user.type(screen.getByLabelText('Domain'), 'help.acme.com')
    expect(screen.queryByTestId('custom-domain-status')).toBeNull()
  })
})

describe('where the field is', () => {
  it('is on the web chat channel page only, inline (no dialog)', () => {
    const web = readFileSync(join(__dirname, '../../channels/hosted-channels.tsx'), 'utf8')
    expect(web).toMatch(/<CustomDomainField\s/)
    const page = readFileSync(join(__dirname, '../../../pages/gateway-detail.tsx'), 'utf8')
    expect(page).not.toMatch(/CustomDomain/)
    const card = readFileSync(join(__dirname, '../custom-domain-card.tsx'), 'utf8')
    expect(card).not.toMatch(/Dialog|Save domain/)
  })
})
