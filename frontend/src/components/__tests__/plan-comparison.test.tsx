import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../test/setup'
import { PlanComparison } from '../plan-comparison'

describe('PlanComparison', () => {
  it('locks Business features for a free org and unlocks them for business', () => {
    const { unmount } = render(<PlanComparison currentPlan="free" />)

    const ssoRow = screen.getByText('SSO / SAML + SCIM').closest('tr')!
    // Free and Pro columns are locked; Business and Enterprise are included.
    expect(ssoRow.querySelector('[data-testid="lock-free"]')).toBeTruthy()
    expect(ssoRow.querySelector('[data-testid="lock-pro"]')).toBeTruthy()
    expect(ssoRow.querySelector('[data-testid="incl-business"]')).toBeTruthy()
    expect(ssoRow.querySelector('[data-testid="incl-enterprise"]')).toBeTruthy()

    unmount()

    render(<PlanComparison currentPlan="business" />)
    const ssoRow2 = screen.getByText('SSO / SAML + SCIM').closest('tr')!
    expect(ssoRow2.querySelector('[data-testid="incl-business"]')).toBeTruthy()
  })

  it('marks enterprise-only features (chargeback) locked below enterprise', () => {
    render(<PlanComparison currentPlan="free" />)
    const row = screen.getByText('Cost attribution / chargeback').closest('tr')!
    expect(row.querySelector('[data-testid="lock-business"]')).toBeTruthy()
    expect(row.querySelector('[data-testid="incl-enterprise"]')).toBeTruthy()
  })

  it('highlights the current tier with a Current badge', () => {
    render(<PlanComparison currentPlan="pro" />)
    expect(screen.getByText('Current')).toBeInTheDocument()
  })

  it('always includes core features across all tiers', () => {
    render(<PlanComparison currentPlan="free" />)
    const core = screen.getByText('Agents, tools, gateways, MCP').closest('tr')!
    expect(core.querySelector('[data-testid="incl-free"]')).toBeTruthy()
    expect(core.querySelector('[data-testid="incl-enterprise"]')).toBeTruthy()
  })
})
