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

const freeStatus = {
  plan: 'free',
  seats: 1,
  status: null,
  hasSubscription: false,
  dunning: false,
  graceUntil: null,
  planExpiresAt: null,
  hasLicenseToken: false,
  stripeConfigured: true,
}

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
    mocked.getStatus.mockResolvedValue(freeStatus)

    render(<BillingTab organizationId={ORG} />)

    await waitFor(() => expect(screen.getByText('Upgrade to Pro')).toBeInTheDocument())
    expect(screen.getByText('Upgrade to Business')).toBeInTheDocument()
    // Enterprise is contact-sales, not a self-serve checkout.
    expect(screen.getByText('Contact sales')).toBeInTheDocument()
    expect(screen.queryByText('Upgrade to Enterprise')).not.toBeInTheDocument()
  })

  it('starts checkout monthly by default and redirects to the returned Stripe url', async () => {
    mocked.getStatus.mockResolvedValue(freeStatus)
    mocked.createCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/go' })

    render(<BillingTab organizationId={ORG} />)

    const btn = await screen.findByText('Upgrade to Pro')
    fireEvent.click(btn)

    await waitFor(() =>
      expect(mocked.createCheckout).toHaveBeenCalledWith(ORG, { plan: 'pro', interval: 'month' }),
    )
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith('https://checkout.stripe.test/go'),
    )
  })

  it('renders the monthly/annual toggle and switches the displayed per-seat price', async () => {
    mocked.getStatus.mockResolvedValue(freeStatus)

    render(<BillingTab organizationId={ORG} />)

    // Monthly is the default: Pro is $20 / seat / month.
    await waitFor(() => expect(screen.getByText('$20')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Annual/ }))

    // Annual shows the per-seat annual price ($200/yr, 2 months free vs $240).
    await waitFor(() => expect(screen.getByText('$200')).toBeInTheDocument())
    expect(screen.getByText(/\$200\/yr vs \$240 — 2 months free/)).toBeInTheDocument()
    // Monthly $20 headline price is gone once annual is selected.
    expect(screen.queryByText('$20')).not.toBeInTheDocument()
  })

  it('passes interval=year to the checkout call when Annual is selected', async () => {
    mocked.getStatus.mockResolvedValue(freeStatus)
    mocked.createCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/annual' })

    render(<BillingTab organizationId={ORG} />)

    await screen.findByText('Upgrade to Pro')
    fireEvent.click(screen.getByRole('button', { name: /Annual/ }))
    fireEvent.click(screen.getByText('Upgrade to Pro'))

    await waitFor(() =>
      expect(mocked.createCheckout).toHaveBeenCalledWith(ORG, { plan: 'pro', interval: 'year' }),
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
