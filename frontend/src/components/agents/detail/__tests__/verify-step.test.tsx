import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '../../../../test/setup'
import { UnverifiedNote, VerifyStepCard, VerifySummary } from '../verify-step'
import type { AgentRun, AgentRunStep } from '@/types'

const step = (over: Partial<AgentRunStep>): AgentRunStep =>
  ({ type: 'verify', timestamp: '2026-06-24T00:00:00Z', ...over } as AgentRunStep)

const run = (metadata: any): AgentRun => ({ metadata } as AgentRun)

describe('VerifyStepCard', () => {
  it('renders a passing gate verdict', () => {
    render(<VerifyStepCard step={step({ output: { verdict: 'pass', failures: [] } })} index={0} />)
    expect(screen.getByText('Passed verification')).toBeInTheDocument()
    expect(screen.getByText('blocking')).toBeInTheDocument()
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

// Run b9803830: no checker gave a verdict (each reply was cut off), and the
// run view said "the checkers still found problems" and showed the internal
// code. A check that could not be done says so, in plain words.
describe('a check no checker could give a verdict on', () => {
  const unchecked = {
    status: 'completed',
    metadata: { verify: { verdict: 'fail', revisions: 0, exhausted: false, unavailable: true, reason: 'the checker could not give a verdict' } },
  } as unknown as AgentRun

  it('says the check could not be done, not that problems were found', () => {
    render(<VerifySummary run={unchecked} />)
    expect(screen.getByText('Verification could not be done')).toBeInTheDocument()
    expect(screen.queryByText('Verification failed')).not.toBeInTheDocument()
  })

  it('marks the answer as not checked', () => {
    render(<UnverifiedNote run={unchecked} />)
    const note = screen.getByTestId('unverified-note')
    expect(note).toHaveTextContent('Not checked: the check could not be done')
    expect(note).not.toHaveTextContent(/found problems/)
    expect(note).not.toHaveTextContent(/verification_unavailable/)
  })

  it('keeps the "found problems" line for an answer the checkers did fail', () => {
    render(<UnverifiedNote run={{ status: 'completed', metadata: { verify: { verdict: 'fail', exhausted: true } } }} />)
    expect(screen.getByTestId('unverified-note')).toHaveTextContent(/still found problems/)
  })

  it('shows on the step why each checker gave no verdict', () => {
    render(
      <VerifyStepCard
        step={step({
          output: {
            verdict: 'fail',
            unavailable: true,
            failures: [{ rule: 'the checker could not give a verdict', checker: 'verify', code: 'verification_unavailable' }],
            checkers: [{ checker: 'checker_1', verdict: 'error', error: "the checker's reply was cut off at its output limit (4096 tokens) before it gave a verdict" }],
          },
        })}
        index={0}
      />,
    )
    expect(screen.getByText('Check could not be done: no checker gave a verdict')).toBeInTheDocument()
    expect(screen.getByTestId('verify-checker-notes')).toHaveTextContent(/checker_1: the checker's reply was cut off at its output limit/)
    expect(screen.queryByText('Failed verification')).not.toBeInTheDocument()
  })
})
