import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../../test/setup'
import { BillingTab } from '../BillingTab'

vi.mock('../../lib/api', () => ({
  billingApi: {
    getStatus: vi.fn(),
    getInvoices: vi.fn(),
    createCheckout: vi.fn(),
    createPortal: vi.fn(),
  },
}))

import { billingApi } from '../../lib/api'

const mocked = billingApi as unknown as {
  getStatus: ReturnType<typeof vi.fn>
  getInvoices: ReturnType<typeof vi.fn>
  createCheckout: ReturnType<typeof vi.fn>
  createPortal: ReturnType<typeof vi.fn>
}

const ORG = 'org-1'

describe('BillingTab', () => {
  beforeEach(() => {
    mocked.getStatus.mockReset()
    mocked.getInvoices.mockReset()
    mocked.createCheckout.mockReset()
    mocked.createPortal.mockReset()
    mocked.getInvoices.mockResolvedValue([])
    // jsdom has no navigation; stub assign so redirect is observable.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { assign: vi.fn() },
    })
  })

  it('shows the current free plan and the upgrade options when Stripe is configured', async () => {
    mocked.getStatus.mockResolvedValue({
      plan: 'free',
      seats: 1,
      status: null,
      hasSubscription: false,
      dunning: false,
      graceUntil: null,
      planExpiresAt: null,
      hasLicenseToken: false,
      stripeConfigured: true,
    })

    render(<BillingTab organizationId={ORG} />)

    await waitFor(() => expect(screen.getByText('Upgrade to Pro')).toBeInTheDocument())
    expect(screen.getByText('Upgrade to Enterprise')).toBeInTheDocument()
  })

  it('starts checkout and redirects to the returned Stripe url', async () => {
    mocked.getStatus.mockResolvedValue({
      plan: 'free',
      seats: 1,
      status: null,
      hasSubscription: false,
      dunning: false,
      graceUntil: null,
      planExpiresAt: null,
      hasLicenseToken: false,
      stripeConfigured: true,
    })
    mocked.createCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/go' })

    render(<BillingTab organizationId={ORG} />)

    const btn = await screen.findByText('Upgrade to Pro')
    fireEvent.click(btn)

    await waitFor(() => expect(mocked.createCheckout).toHaveBeenCalledWith(ORG, { plan: 'pro' }))
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith('https://checkout.stripe.test/go'),
    )
  })

  it('surfaces a dunning warning on a paid plan with a failed payment', async () => {
    mocked.getStatus.mockResolvedValue({
      plan: 'pro',
      seats: 5,
      status: 'past_due',
      hasSubscription: true,
      dunning: true,
      graceUntil: new Date(Date.now() + 86400000).toISOString(),
      planExpiresAt: null,
      hasLicenseToken: true,
      stripeConfigured: true,
    })

    render(<BillingTab organizationId={ORG} />)

    await waitFor(() => expect(screen.getByText('Payment issue')).toBeInTheDocument())
    expect(screen.getByText('Manage billing')).toBeInTheDocument()
  })
})
