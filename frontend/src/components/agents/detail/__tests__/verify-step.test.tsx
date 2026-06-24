import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '../../../../test/setup'
import { VerifyStepCard, VerifySummary } from '../verify-step'
import type { AgentRun, AgentRunStep } from '@/types'

const step = (over: Partial<AgentRunStep>): AgentRunStep =>
  ({ type: 'verify', timestamp: '2026-06-24T00:00:00Z', ...over } as AgentRunStep)

const run = (metadata: any): AgentRun => ({ metadata } as AgentRun)

describe('VerifyStepCard', () => {
  it('renders a passing gate verdict', () => {
    render(<VerifyStepCard step={step({ output: { verdict: 'pass', failures: [] } })} index={0} />)
    expect(screen.getByText('Passed verification')).toBeInTheDocument()
    expect(screen.getByText('gate')).toBeInTheDocument()
  })

  it('renders a failed gate revision with its failures', () => {
    render(
      <VerifyStepCard
        step={step({
          output: {
            verdict: 'fail',
            revision: 2,
            failures: [{ rule: 'missing total', evidence: 'no sum line', checker: 'c1' }],
          },
        })}
        index={1}
      />,
    )
    expect(screen.getByText('Failed verification')).toBeInTheDocument()
    expect(screen.getByText('revision 2')).toBeInTheDocument()
    expect(screen.getByText(/missing total/)).toBeInTheDocument()
    expect(screen.getByText(/no sum line/)).toBeInTheDocument()
  })

  it('renders an advisory mid-run check', () => {
    render(
      <VerifyStepCard
        step={step({ input: { mode: 'mid_loop' }, output: { verdict: 'fail', advisory: true, failures: [] } })}
        index={2}
      />,
    )
    expect(screen.getByText('Flagged issues (advisory)')).toBeInTheDocument()
    expect(screen.getByText('mid-run')).toBeInTheDocument()
  })
})

describe('VerifySummary', () => {
  it('renders nothing without a verify verdict', () => {
    const { container } = render(<VerifySummary run={run(undefined)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a passing verdict', () => {
    render(<VerifySummary run={run({ verify: { verdict: 'pass', revisions: 0 } })} />)
    expect(screen.getByText('Verification passed')).toBeInTheDocument()
  })

  it('renders a failed verdict with revisions and exhausted budget', () => {
    render(<VerifySummary run={run({ verify: { verdict: 'fail', revisions: 2, exhausted: true } })} />)
    expect(screen.getByText('Verification failed')).toBeInTheDocument()
    expect(screen.getByText(/2 revisions/)).toBeInTheDocument()
    expect(screen.getByText(/budget exhausted/)).toBeInTheDocument()
  })
})
