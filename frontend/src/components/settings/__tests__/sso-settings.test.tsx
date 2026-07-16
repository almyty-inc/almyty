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
  },
}))

vi.mock('../../../store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

vi.mock('../../../lib/clipboard', () => ({
  useCopySensitive: () => vi.fn(),
}))

import { apiGet, ssoApi } from '../../../lib/api'

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
