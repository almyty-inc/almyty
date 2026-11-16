import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '@/test/setup'
import { VerifyStepCard } from '../verify-step'
import type { AgentRunStep } from '@/types'

const step = (output: Record<string, unknown>): AgentRunStep => ({ type: 'verify', timestamp: '2026-11-16T00:00:00Z', output } as AgentRunStep)

/**
 * At 390px the answer check's findings were squeezed into a one-word column
 * beside its badges, so one run's page grew to 20,000px. The card now uses
 * the other steps' frame: below sm the findings take the full width.
 */
describe('the answer check step on a phone', () => {
  it('puts the findings on their own full-width row below sm', () => {
    render(<VerifyStepCard step={step({ verdict: 'fail', failures: [{ claim: 'x', reason: 'not in the tool results' }] })} index={3} />)
    const card = screen.getByTestId('verify-step-3')
    expect(card).toHaveClass('flex-wrap', 'sm:flex-nowrap')
    const findings = screen.getByTestId('verify-findings').parentElement!
    expect(findings).toHaveClass('basis-full', 'order-last', 'sm:basis-auto')
  })

  it('numbers the step like the others', () => {
    render(<VerifyStepCard step={step({ verdict: 'pass', failures: [] })} index={3} />)
    expect(screen.getByLabelText('Step 4')).toHaveTextContent('4')
  })
})
