import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '../../../test/setup'

import { HostedChatBuilder } from '../hosted-chat-builder'
import { hostedChatConfigFrom } from '../hosted-chat-config'

vi.mock('@/lib/api', () => ({
  gatewaysApi: { update: vi.fn().mockResolvedValue({}), getHostedChatSso: vi.fn() },
  getApiBaseUrl: () => '',
}))

import { gatewaysApi } from '@/lib/api'

const GW = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
// Deliberately not what the frontend would build for slug "acme": the page
// must show what the API answers, not assemble its own.
const ACS = 'https://acme.edge.example/tenant-api/public/chat/acme/auth/sso/saml/acs'
const CUSTOM_ACS = 'https://chat.acme.example/tenant-api/public/chat/acme/auth/sso/saml/acs'
const OIDC = 'https://acme.edge.example/tenant-api/public/chat/acme/auth/sso/callback'

const gateway = (authMode = 'sso') => ({
  id: GW,
  configuration: { hostedChat: { ...hostedChatConfigFrom(null), slug: 'acme', appName: 'Acme', authMode } },
})

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.mocked(gatewaysApi.getHostedChatSso).mockReset()
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

describe('hosted chat SSO sign-in URLs on the gateway page', () => {
  it('shows the ACS URLs the API answers, inline, each with a copy button', async () => {
    vi.mocked(gatewaysApi.getHostedChatSso).mockResolvedValue({
      protocol: 'saml',
      samlAcsUrls: [ACS, CUSTOM_ACS],
      oidcRedirectUri: OIDC,
    })
    render(<HostedChatBuilder gateway={gateway()} entitlements={{ enterpriseAuth: true }} />)

    expect(await screen.findByText(ACS)).toBeInTheDocument()
    expect(screen.getByText(CUSTOM_ACS)).toBeInTheDocument()
    // The org uses SAML, so the OIDC redirect URI is not offered.
    expect(screen.queryByText(OIDC)).not.toBeInTheDocument()
    expect(gatewaysApi.getHostedChatSso).toHaveBeenCalledWith(GW)
    // Inline on the page, never in a dialog.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: `Copy ${ACS}` }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ACS))
  })

  it('shows the OIDC redirect URI for an organization on OIDC', async () => {
    vi.mocked(gatewaysApi.getHostedChatSso).mockResolvedValue({
      protocol: 'oidc',
      samlAcsUrls: [ACS],
      oidcRedirectUri: OIDC,
    })
    render(<HostedChatBuilder gateway={gateway()} entitlements={{ enterpriseAuth: true }} />)

    expect(await screen.findByText(OIDC)).toBeInTheDocument()
    expect(screen.queryByText(ACS)).not.toBeInTheDocument()
  })

  it('is not asked for when access is not SSO, or the org has no SSO entitlement', () => {
    render(<HostedChatBuilder gateway={gateway('email_otp')} entitlements={{ enterpriseAuth: true }} />)
    render(<HostedChatBuilder gateway={gateway('sso')} entitlements={{ enterpriseAuth: false }} />)
    expect(gatewaysApi.getHostedChatSso).not.toHaveBeenCalled()
  })

  it('assembles no sign-in URL in the frontend', () => {
    const source = readFileSync(join(__dirname, '..', 'hosted-chat-sso-urls.tsx'), 'utf8')
    expect(source).not.toMatch(/saml\/acs|auth\/sso\/callback|hostedChatUrl/)
  })
})
