import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { QueryError } from '../ui/query-error'
import { BillingTab } from '../BillingTab'
import { billingApi } from '../../lib/api'

// The global exception filter answers every error as
// { error: { code, message, statusCode, ... } }. There is no top-level
// `message`, so every handler that read err.response.data.message fell
// straight through to its hardcoded fallback and the backend's reason --
// an entitlement 402's requiredEntitlements, a publish blocker, an
// access policy's decision.reason -- never reached the user.

vi.mock('../../lib/api', () => ({
  billingApi: {
    getStatus: vi.fn(),
    getInvoices: vi.fn(),
    createCheckout: vi.fn(),
    createPortal: vi.fn(),
  },
}))

vi.mock('../../lib/analytics', () => ({ captureEvent: vi.fn() }))


const notifyError = vi.fn()
vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: notifyError,
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

describe('QueryError', () => {
  it('shows the backend reason from the wrapped shape, not axios noise', () => {
    render(
      <QueryError
        error={{
          message: 'Request failed with status code 402',
          response: {
            status: 402,
            data: {
              error: {
                code: 'ENTITLEMENT_REQUIRED',
                message: 'Cost governance is not on the Team plan.',
                requiredEntitlements: ['cost_governance'],
              },
            },
          },
        }}
      />,
    )

    expect(
      screen.getByText('Cost governance is not on the Team plan.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Request failed with status code 402'),
    ).not.toBeInTheDocument()
  })

  it('still reads a native Error', () => {
    render(<QueryError error={new Error('Network Error')} />)
    expect(screen.getByText('Network Error')).toBeInTheDocument()
  })
})

describe('a mutation toast repeats the backend reason', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(billingApi.getStatus).mockResolvedValue({
      plan: 'free',
      seats: 1,
      status: null,
      hasSubscription: false,
      stripeConfigured: true,
    } as any)
  })

  it('BillingTab checkout says why the provider refused', async () => {
    vi.mocked(billingApi.createCheckout).mockRejectedValue({
      response: {
        status: 402,
        data: {
          error: {
            code: 'ENTITLEMENT_REQUIRED',
            message: 'This organization already has an active subscription.',
            requiredEntitlements: ['billing'],
          },
        },
      },
    })

    const user = userEvent.setup()
    render(<BillingTab organizationId="org-1" />)

    await user.click((await screen.findAllByRole('button', { name: /Upgrade to/ }))[0])

    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        'Checkout failed',
        'This organization already has an active subscription.',
      ),
    )
  })
})

describe('checkout and the billing portal without a link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(billingApi.getStatus).mockResolvedValue({
      plan: 'team',
      seats: 3,
      status: 'active',
      hasSubscription: true,
      stripeConfigured: true,
    } as any)
    vi.mocked(billingApi.getInvoices).mockResolvedValue([] as any)
  })

  it('says the provider returned no checkout link instead of doing nothing', async () => {
    vi.mocked(billingApi.createCheckout).mockResolvedValue({} as any)

    const user = userEvent.setup()
    render(<BillingTab organizationId="org-1" />)

    await user.click((await screen.findAllByRole('button', { name: /Upgrade to/ }))[0])

    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        'Checkout could not be opened',
        'The billing provider did not return a checkout link. Please try again.',
      ),
    )
  })

  it('says the provider returned no portal link', async () => {
    vi.mocked(billingApi.createPortal).mockResolvedValue({ url: '' } as any)

    const user = userEvent.setup()
    render(<BillingTab organizationId="org-1" />)

    await user.click(await screen.findByRole('button', { name: /Manage billing/ }))

    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        'Billing portal could not be opened',
        'The billing provider did not return a portal link. Please try again.',
      ),
    )
  })
})
