import { describe, it, expect, vi, beforeEach } from 'vitest'

import { render, screen, fireEvent } from '../../../test/setup'
import { GettingStartedCard } from '../getting-started-card'
import type { OnboardingState } from '@/lib/api'
import { captureEvent } from '@/lib/analytics'

vi.mock('@/lib/analytics', () => ({
  captureEvent: vi.fn(),
}))

function makeState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    steps: {
      provider: false,
      api: false,
      gateway: false,
      first_call: false,
      external_client: false,
      ...(overrides.steps || {}),
    },
    sampleWorkspace: false,
    dismissed: false,
    activatedSampleAt: null,
    activatedRealAt: null,
    ...overrides,
  }
}

describe('GettingStartedCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders 0 of 3 complete on an empty org', () => {
    render(<GettingStartedCard state={makeState()} />)
    expect(screen.getByText('0 of 3 complete')).toBeInTheDocument()
    const bar = screen.getByRole('progressbar', { name: /onboarding progress/i })
    expect(bar).toHaveAttribute('aria-valuenow', '0')
  })

  it('reflects server-computed step completion in the progress ring', () => {
    // provider is intentionally NOT a ring step (it is the contextual
    // agent on-ramp), so only api/gateway/first_call count toward the ring.
    render(
      <GettingStartedCard
        state={makeState({ steps: { provider: true, api: true, gateway: true, first_call: false, external_client: false } })}
      />,
    )
    expect(screen.getByText('2 of 3 complete')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: /onboarding progress/i })).toHaveAttribute(
      'aria-valuenow',
      '2',
    )
  })

  it('shows the model on-ramp only while no model is connected', () => {
    const { rerender } = render(<GettingStartedCard state={makeState()} />)
    expect(screen.getByText(/Building agents on almyty/i)).toBeInTheDocument()
    rerender(
      <GettingStartedCard
        state={makeState({ steps: { provider: true, api: false, gateway: false, first_call: false, external_client: false } })}
      />,
    )
    expect(screen.queryByText(/Building agents on almyty/i)).not.toBeInTheDocument()
  })

  it('shows the external-client bonus row only after first_call', () => {
    const { rerender } = render(<GettingStartedCard state={makeState()} />)
    expect(screen.queryByText(/Connect an external client/i)).not.toBeInTheDocument()

    rerender(
      <GettingStartedCard
        state={makeState({ steps: { provider: true, api: true, gateway: true, first_call: true, external_client: false } })}
      />,
    )
    expect(screen.getByText(/Connect an external client/i)).toBeInTheDocument()
  })

  it('celebrates once an external client has called the gateway', () => {
    render(
      <GettingStartedCard
        state={makeState({ steps: { provider: true, api: true, gateway: true, first_call: true, external_client: true } })}
      />,
    )
    expect(screen.getByText('An external client called your gateway.')).toBeInTheDocument()
  })

  it('offers the sample-workspace action until it is seeded', () => {
    const onSeedSample = vi.fn()
    const { rerender } = render(
      <GettingStartedCard state={makeState()} onSeedSample={onSeedSample} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /load sample workspace/i }))
    expect(onSeedSample).toHaveBeenCalledTimes(1)

    rerender(
      <GettingStartedCard state={makeState({ sampleWorkspace: true })} onSeedSample={onSeedSample} />,
    )
    expect(screen.queryByRole('button', { name: /load sample workspace/i })).not.toBeInTheDocument()
  })

  it('fires an observed step-completed event when a step flips complete between renders', () => {
    const { rerender } = render(<GettingStartedCard state={makeState()} />)
    expect(captureEvent).not.toHaveBeenCalledWith('onboarding_step_completed', expect.anything())

    rerender(
      <GettingStartedCard state={makeState({ steps: { provider: true, api: false, gateway: false, first_call: false, external_client: false } })} />,
    )
    expect(captureEvent).toHaveBeenCalledWith('onboarding_step_completed', {
      step: 'provider',
      via: 'observed',
    })
  })

  it('fires an activation event when the org first activates', () => {
    const { rerender } = render(<GettingStartedCard state={makeState()} />)
    rerender(
      <GettingStartedCard state={makeState({ activatedSampleAt: '2026-01-01T00:00:00.000Z' })} />,
    )
    expect(captureEvent).toHaveBeenCalledWith('activation', { kind: 'sample' })
  })

  it('invokes onDismiss when the dismiss control is clicked', () => {
    const onDismiss = vi.fn()
    render(<GettingStartedCard state={makeState()} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss getting started/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
