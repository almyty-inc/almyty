import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../../test/setup'
import { SsoSettings } from '../sso-settings'
import type { EntitlementSnapshot } from '../../../hooks/use-entitlement'

// The entitlements query and the SSO config query both go through the api
// module, so mock both entry points.
vi.mock('../../../lib/api', () => ({
  apiGet: vi.fn(),
  ssoApi: {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    rotateScimToken: vi.fn(),
    revealScimToken: vi.fn(),
    listDomains: vi.fn(async () => []),
  },
}))

vi.mock('../../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

vi.mock('../../../lib/clipboard', () => ({
  useCopySensitive: () => vi.fn(),
}))

import { apiGet, ssoApi } from '../../../lib/api'
import { useOrganizationStore } from '../../../store/organization'

const mockedApiGet = apiGet as unknown as ReturnType<typeof vi.fn>
const mockedGetConfig = ssoApi.getConfig as unknown as ReturnType<typeof vi.fn>

const withEntitlements = (entitlements: string[]): EntitlementSnapshot => ({
  edition: entitlements.includes('sso') ? 'enterprise' : 'community',
  entitlements,
  limits: {},
  expiresAt: null,
})

const ssoConfig = {
  configured: false,
  protocol: 'saml' as const,
  enabled: false,
  jitProvisioning: false,
  defaultRole: 'member',
  scimEnabled: false,
  scimBaseUrl: 'https://api.almyty.com/scim/v2',
  scimTokenSet: false,
}

describe('SsoSettings entitlement gating', () => {
  beforeEach(() => {
    mockedApiGet.mockReset()
    mockedGetConfig.mockReset()
    mockedGetConfig.mockResolvedValue(ssoConfig)
  })

  it('shows the upgrade prompt (not the config form) when sso is not granted', async () => {
    mockedApiGet.mockResolvedValue(withEntitlements(['agents', 'tools']))

    render(<SsoSettings />)

    // The lock state names the unlocking tier and links to billing.
    await waitFor(() =>
      expect(screen.getByText(/upgrade to unlock it/i)).toBeInTheDocument(),
    )
    expect(screen.getByRole('link', { name: /upgrade to business|view plans/i })).toHaveAttribute(
      'href',
      '/settings/billing',
    )
    // The real form control must not render, and the gated config endpoint
    // must not even be queried.
    expect(screen.queryByText(/enable sso login/i)).not.toBeInTheDocument()
    expect(mockedGetConfig).not.toHaveBeenCalled()
  })

  it('renders the real SSO config form when sso is granted', async () => {
    mockedApiGet.mockResolvedValue(withEntitlements(['agents', 'tools', 'sso']))

    render(<SsoSettings />)

    await waitFor(() => expect(screen.getByText(/enable sso login/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /save sso settings/i })).toBeInTheDocument()
    expect(screen.queryByText(/upgrade to unlock it/i)).not.toBeInTheDocument()
    expect(mockedGetConfig).toHaveBeenCalled()
  })
})

describe('SsoSettings addresses for the identity provider', () => {
  beforeEach(() => {
    mockedApiGet.mockReset()
    mockedGetConfig.mockReset()
    mockedApiGet.mockResolvedValue(withEntitlements(['sso']))
    useOrganizationStore.setState({ currentOrganization: { id: 'org-123', name: 'Velora Energy' } as any })
  })

  it('shows the SAML reply URL, the metadata and the sign-in link for this organization', async () => {
    mockedGetConfig.mockResolvedValue(ssoConfig)
    render(<SsoSettings />)
    await waitFor(() => expect(screen.getByTestId('sso-idp-addresses')).toBeInTheDocument())
    expect(screen.getByLabelText('Reply URL (assertion consumer service)')).toHaveValue('https://api.almyty.com/sso/org-123/saml/callback')
    expect(screen.getByLabelText('Service provider metadata')).toHaveValue('https://api.almyty.com/sso/org-123/saml/metadata')
    expect(screen.getByLabelText('Sign-in link')).toHaveValue('https://api.almyty.com/sso/org-123/saml/login')
  })

  it('shows the OIDC redirect URI to register and the OIDC sign-in link', async () => {
    mockedGetConfig.mockResolvedValue({ ...ssoConfig, configured: true, protocol: 'oidc' })
    render(<SsoSettings />)
    await waitFor(() => expect(screen.getByTestId('sso-idp-addresses')).toBeInTheDocument())
    expect(screen.getByLabelText('Redirect URI to register')).toHaveValue('https://api.almyty.com/sso/org-123/oidc/callback')
    expect(screen.getByLabelText('Sign-in link')).toHaveValue('https://api.almyty.com/sso/org-123/oidc/login')
  })
})
