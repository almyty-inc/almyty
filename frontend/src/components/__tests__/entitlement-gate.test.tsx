import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { render } from '../../test/setup'
import { EntitlementGate } from '../entitlement-gate'
import type { EntitlementSnapshot } from '../../hooks/use-entitlement'

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(),
}))

import { apiGet } from '../../lib/api'

const mockedApiGet = apiGet as unknown as ReturnType<typeof vi.fn>

const community: EntitlementSnapshot = {
  edition: 'community',
  entitlements: ['agents', 'tools', 'byok'],
  limits: {},
  expiresAt: null,
}

const enterprise: EntitlementSnapshot = {
  edition: 'enterprise',
  entitlements: ['agents', 'tools', 'byok', 'sso'],
  limits: { seats: 25 },
  expiresAt: null,
}

describe('EntitlementGate', () => {
  beforeEach(() => {
    mockedApiGet.mockReset()
  })

  it('hides children when the community license lacks the feature', async () => {
    mockedApiGet.mockResolvedValue(community)
    render(
      <EntitlementGate feature="sso">
        <div>SSO Settings</div>
      </EntitlementGate>,
    )
    // Give the query a tick to resolve, then assert it stays hidden.
    await waitFor(() => expect(mockedApiGet).toHaveBeenCalled())
    expect(screen.queryByText('SSO Settings')).not.toBeInTheDocument()
  })

  it('renders children when the license grants the feature', async () => {
    mockedApiGet.mockResolvedValue(enterprise)
    render(
      <EntitlementGate feature="sso">
        <div>SSO Settings</div>
      </EntitlementGate>,
    )
    await waitFor(() => expect(screen.getByText('SSO Settings')).toBeInTheDocument())
  })

  it('renders the fallback in lock mode when the feature is not granted', async () => {
    mockedApiGet.mockResolvedValue(community)
    render(
      <EntitlementGate feature="sso" mode="lock" fallback={<div>Upgrade to unlock SSO</div>}>
        <div>SSO Settings</div>
      </EntitlementGate>,
    )
    await waitFor(() =>
      expect(screen.getByText('Upgrade to unlock SSO')).toBeInTheDocument(),
    )
    expect(screen.queryByText('SSO Settings')).not.toBeInTheDocument()
  })
})
