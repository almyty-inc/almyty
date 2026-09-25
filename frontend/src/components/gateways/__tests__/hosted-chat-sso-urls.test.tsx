import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render } from '../../../test/setup'

import { WebPlaceSettings } from '../../agent-apps/web-place'
import type { AgentApp, AppDistribution } from '@/lib/agent-apps'

vi.mock('@/lib/api', () => ({
  gatewaysApi: {
    update: vi.fn().mockResolvedValue({}),
    getHostedChatSso: vi.fn(),
    getById: vi.fn().mockResolvedValue({ id: 'gw', type: 'hosted_chat', configuration: {} }),
    getCustomDomain: vi.fn().mockResolvedValue(null),
  },
  getApiBaseUrl: () => '',
}))

let entitled: string[] = []
vi.mock('@/hooks/use-entitlement', () => ({
  useEntitlements: () => ({ has: (key: string) => entitled.includes(key) }),
}))

import { gatewaysApi } from '@/lib/api'

const GW = '3e7f8f3a-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
// Deliberately not what the frontend would build for slug "acme": the page
// must show what the API answers, not assemble its own.
const ACS = 'https://acme.edge.example/tenant-api/public/chat/acme/auth/sso/saml/acs'
const CUSTOM_ACS = 'https://chat.acme.example/tenant-api/public/chat/acme/auth/sso/saml/acs'
const OIDC = 'https://acme.edge.example/tenant-api/public/chat/acme/auth/sso/callback'

const app = (authMode = 'sso') => ({ slug: 'acme', name: 'Acme', authMode, agentIds: [], branding: {} }) as unknown as AgentApp
const web = { id: 'd-1', appId: 'a-1', target: 'web', status: 'live', gatewayId: GW } as AppDistribution
const renderWeb = (authMode = 'sso') => render(<WebPlaceSettings app={app(authMode)} distribution={web} />)

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.mocked(gatewaysApi.getHostedChatSso).mockReset()
  entitled = ['sso']
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

describe('hosted chat SSO sign-in URLs on the web app page', () => {
  it('shows the ACS URLs the API answers, inline, each with a copy button', async () => {
    vi.mocked(gatewaysApi.getHostedChatSso).mockResolvedValue({
      protocol: 'saml',
      samlAcsUrls: [ACS, CUSTOM_ACS],
      oidcRedirectUri: OIDC,
    })
    renderWeb()

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
    renderWeb()

    expect(await screen.findByText(OIDC)).toBeInTheDocument()
    expect(screen.queryByText(ACS)).not.toBeInTheDocument()
  })

  it('is not asked for when access is not SSO, or the org has no SSO entitlement', () => {
    renderWeb('email_otp')
    entitled = []
    renderWeb('sso')
    expect(gatewaysApi.getHostedChatSso).not.toHaveBeenCalled()
  })

  it('assembles no sign-in URL in the frontend', () => {
    const source = readFileSync(join(__dirname, '..', 'hosted-chat-sso-urls.tsx'), 'utf8')
    expect(source).not.toMatch(/saml\/acs|auth\/sso\/callback|hostedChatUrl/)
  })
})
